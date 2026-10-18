package android.net;
public class NetworkCapabilities { public static final int TRANSPORT_WIFI=1,TRANSPORT_VPN=4; public boolean hasTransport(int value){return value==TRANSPORT_WIFI;} }
