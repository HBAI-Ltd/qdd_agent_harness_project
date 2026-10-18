package cn.qdd.screenbridge;

import android.Manifest;
import android.bluetooth.BluetoothAdapter;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.BluetoothGatt;
import android.bluetooth.BluetoothGattCallback;
import android.bluetooth.BluetoothGattCharacteristic;
import android.bluetooth.BluetoothGattDescriptor;
import android.bluetooth.BluetoothGattService;
import android.bluetooth.BluetoothManager;
import android.bluetooth.BluetoothProfile;
import android.bluetooth.BluetoothStatusCodes;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Handler;
import android.os.SystemClock;
import java.util.ArrayDeque;
import java.util.Arrays;
import java.util.UUID;

/** Only the user-selected bonded controller, with one encrypted write at a time. */
final class ImeGattClient {
  static final String ADDRESS = "imeBoardAddress", NAME = "imeBoardName";
  static final UUID SERVICE = UUID.fromString("9bded201-39ba-4a19-8ff7-25c9d00a0001");
  static final UUID INDICATION = UUID.fromString("9bded201-39ba-4a19-8ff7-25c9d00a0002");
  static final UUID WRITE = UUID.fromString("9bded201-39ba-4a19-8ff7-25c9d00a0003");
  private static final UUID CCCD = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb");
  interface Listener { void availability(boolean ready, String status); void packet(byte[] bytes); }
  private final Context context;
  private final Handler main;
  private final Listener listener;
  private final ArrayDeque<byte[]> queue = new ArrayDeque<>();
  private BluetoothGatt current;
  private BluetoothGattCharacteristic writer;
  private String address;
  private boolean subscribed, writing, closed;
  private long retryAt, operationDeadline;

  ImeGattClient(Context context, Handler main, Listener listener) { this.context = context; this.main = main; this.listener = listener; }
  static boolean permitted(Context context) {
    return Build.VERSION.SDK_INT < 31 || context.checkSelfPermission(Manifest.permission.BLUETOOTH_CONNECT) == PackageManager.PERMISSION_GRANTED;
  }
  void ensureConnected() {
    if (closed) return;
    if (!permitted(context)) {
      if (current != null) disconnect("中文输入需要在 App 中允许附近设备权限");
      else listener.availability(false, "中文输入需要在 App 中允许附近设备权限");
      return;
    }
    String selected = context.getSharedPreferences("screen-source", Context.MODE_PRIVATE).getString(ADDRESS, "");
    if (current != null && selected.equals(address)) {
      if (operationDeadline != 0 && SystemClock.elapsedRealtime() >= operationDeadline) disconnect("中文输入通道操作超时，可能已输入，请勿重复发送");
      return;
    }
    if (current != null) disconnect("已更换中文输入控制器");
    if (SystemClock.elapsedRealtime() < retryAt) return;
    retryAt = SystemClock.elapsedRealtime() + 5000;
    if (!BluetoothAdapter.checkBluetoothAddress(selected)) { listener.availability(false, "请先在 App 中选择已配对的中文输入控制器"); return; }
    try {
      BluetoothManager manager = context.getSystemService(BluetoothManager.class);
      BluetoothAdapter adapter = manager == null ? null : manager.getAdapter();
      if (adapter == null || !adapter.isEnabled()) { listener.availability(false, "请先开启系统蓝牙"); return; }
      BluetoothDevice target = null;
      for (BluetoothDevice device : adapter.getBondedDevices()) {
        String name = device.getName();
        if (selected.equals(device.getAddress()) && device.getBondState() == BluetoothDevice.BOND_BONDED
            && name != null && name.startsWith("QDD-Passport-")) { target = device; break; }
      }
      if (target == null) { listener.availability(false, "选择的控制器尚未在系统蓝牙中配对"); return; }
      address = selected; listener.availability(false, "正在连接中文输入通道…");
      operationDeadline = SystemClock.elapsedRealtime() + 8000;
      current = target.connectGatt(context, false, callback, BluetoothDevice.TRANSPORT_LE);
      if (current == null) disconnect("中文输入通道暂时无法连接");
    } catch (RuntimeException unavailable) { disconnect("中文输入通道不可用，请检查蓝牙权限和所选控制器"); }
  }
  private void clearQueue() { while (!queue.isEmpty()) Arrays.fill(queue.removeFirst(), (byte)0); writing = false; }
  private void disconnect(String status) {
    BluetoothGatt old = current; current = null; writer = null; subscribed = false; operationDeadline = 0; clearQueue();
    if (old != null) { try { old.close(); } catch (RuntimeException ignored) {} }
    listener.availability(false, status);
  }
  void close() { closed = true; disconnect("设备中文输入已停用"); }
  void send(byte[] value) {
    if (!subscribed || current == null || writer == null || value == null) return;
    // These packets contain readiness/results only, never input text.
    if (value.length != 6 && value.length != 15) { disconnect("中文输入协议错误"); return; }
    if (queue.size() >= 8) { disconnect("中文输入确认通道繁忙，请重新选择输入法"); return; }
    queue.addLast(value.clone()); pump();
  }
  @SuppressWarnings("deprecation")
  private void pump() {
    if (writing || queue.isEmpty() || !subscribed || current == null || writer == null) return;
    writing = true;
    operationDeadline = SystemClock.elapsedRealtime() + 3000;
    boolean accepted;
    try {
      if (Build.VERSION.SDK_INT >= 33) accepted = current.writeCharacteristic(writer, queue.peekFirst(), BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS;
      else { writer.setWriteType(BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT); writer.setValue(queue.peekFirst()); accepted = current.writeCharacteristic(writer); }
    } catch (RuntimeException denied) { accepted = false; }
    if (!accepted) disconnect("中文输入确认发送失败，请检查蓝牙连接");
  }
  private void received(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] source) {
    if (!INDICATION.equals(characteristic.getUuid()) || source == null || source.length > Utf8ImeProtocol.LIMIT + 12) return;
    final byte[] bytes = source.clone();
    main.post(() -> {
      try { if (!closed && current == gatt && subscribed) listener.packet(bytes); }
      finally { Arrays.fill(bytes, (byte)0); }
    });
  }
  private final BluetoothGattCallback callback = new BluetoothGattCallback() {
    @Override public void onConnectionStateChange(BluetoothGatt gatt, int status, int state) {
      main.post(() -> {
        if (closed || current != gatt) return;
        if (status == BluetoothGatt.GATT_SUCCESS && state == BluetoothProfile.STATE_CONNECTED) {
          operationDeadline = SystemClock.elapsedRealtime() + 8000;
          try { if (!gatt.discoverServices()) disconnect("无法读取中文输入服务"); }
          catch (RuntimeException unavailable) { disconnect("无法读取中文输入服务"); }
        } else disconnect("中文输入蓝牙连接已断开");
      });
    }
    @Override public void onServiceChanged(BluetoothGatt gatt) {
      main.post(() -> { if (!closed && current == gatt) { retryAt = 0; disconnect("控制器服务已更新，正在重新连接中文输入"); } });
    }
    @SuppressWarnings("deprecation")
    @Override public void onServicesDiscovered(BluetoothGatt gatt, int status) {
      main.post(() -> {
        if (closed || current != gatt) return;
        try {
          BluetoothGattService service = status == BluetoothGatt.GATT_SUCCESS ? gatt.getService(SERVICE) : null;
          BluetoothGattCharacteristic indication = service == null ? null : service.getCharacteristic(INDICATION);
          writer = service == null ? null : service.getCharacteristic(WRITE);
          BluetoothGattDescriptor descriptor = indication == null ? null : indication.getDescriptor(CCCD);
          if (writer == null || indication == null || descriptor == null
              || (writer.getProperties() & BluetoothGattCharacteristic.PROPERTY_WRITE) == 0
              || (indication.getProperties() & BluetoothGattCharacteristic.PROPERTY_INDICATE) == 0) {
            disconnect("控制器未提供中文输入服务，请更新对应固件"); return;
          }
          if (!gatt.setCharacteristicNotification(indication, true)) { disconnect("无法订阅中文输入通道"); return; }
          writing = true;
          operationDeadline = SystemClock.elapsedRealtime() + 3000;
          boolean accepted;
          if (Build.VERSION.SDK_INT >= 33) accepted = gatt.writeDescriptor(descriptor, BluetoothGattDescriptor.ENABLE_INDICATION_VALUE) == BluetoothStatusCodes.SUCCESS;
          else { descriptor.setValue(BluetoothGattDescriptor.ENABLE_INDICATION_VALUE); accepted = gatt.writeDescriptor(descriptor); }
          if (!accepted) disconnect("无法启用已认证的中文输入通道");
        } catch (RuntimeException unavailable) { disconnect("中文输入服务不可用，请检查蓝牙权限"); }
      });
    }
    @Override public void onDescriptorWrite(BluetoothGatt gatt, BluetoothGattDescriptor descriptor, int status) {
      main.post(() -> {
        if (closed || current != gatt || !CCCD.equals(descriptor.getUuid())) return;
        writing = false; operationDeadline = 0;
        if (status != BluetoothGatt.GATT_SUCCESS) { disconnect("中文输入订阅失败，请确认蓝牙已配对"); return; }
        subscribed = true; listener.availability(true, "中文输入蓝牙通道已连接"); pump();
      });
    }
    @Override public void onCharacteristicWrite(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, int status) {
      main.post(() -> {
        if (closed || current != gatt || !WRITE.equals(characteristic.getUuid())) return;
        if (status != BluetoothGatt.GATT_SUCCESS || !writing || queue.isEmpty()) { disconnect("中文输入确认未完成，可能已输入，请勿重复发送"); return; }
        Arrays.fill(queue.removeFirst(), (byte)0); writing = false; operationDeadline = 0; pump();
      });
    }
    @Override public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic, byte[] value) { received(gatt, characteristic, value); }
    @SuppressWarnings("deprecation")
    @Override public void onCharacteristicChanged(BluetoothGatt gatt, BluetoothGattCharacteristic characteristic) { received(gatt, characteristic, characteristic.getValue()); }
  };
}
