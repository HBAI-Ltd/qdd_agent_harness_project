package cn.qdd.screenbridge;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Paths;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Element;
import org.w3c.dom.NodeList;

/** Packaging contract: system-selected IME is the sole production text entry. */
public final class ImeRegistrationTest {
  private static final String ANDROID = "http://schemas.android.com/apk/res/android";
  private static void check(boolean value, String message) { if (!value) throw new AssertionError(message); }
  public static void main(String[] args) throws Exception {
    String root = args[0];
    DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance(); factory.setNamespaceAware(true);
    factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
    NodeList services = factory.newDocumentBuilder().parse(Paths.get(root,"AndroidManifest.xml").toFile()).getElementsByTagName("service");
    int imeCount = 0;
    for (int i = 0; i < services.getLength(); i++) {
      Element service = (Element)services.item(i);
      check(!service.getAttributeNS(ANDROID,"permission").equals("android.permission.BIND_ACCESSIBILITY_SERVICE"), "No accessibility input service");
      if (!service.getAttributeNS(ANDROID,"name").equals(".QddInputMethodService")) continue;
      imeCount++;
      check(service.getAttributeNS(ANDROID,"permission").equals("android.permission.BIND_INPUT_METHOD"), "Only Android can bind the IME");
      check(service.getAttributeNS(ANDROID,"exported").equals("true"), "System can discover the IME");
      NodeList actions = service.getElementsByTagName("action");
      check(actions.getLength() == 1 && ((Element)actions.item(0)).getAttributeNS(ANDROID,"name").equals("android.view.InputMethod"), "IME action registered");
      NodeList metadata = service.getElementsByTagName("meta-data");
      check(metadata.getLength() == 1 && ((Element)metadata.item(0)).getAttributeNS(ANDROID,"resource").equals("@xml/qdd_input_method"), "IME XML registered");
    }
    check(imeCount == 1, "Exactly one selectable device IME must be registered");
    String screen = new String(Files.readAllBytes(Paths.get(root,"src/cn/qdd/screenbridge/ScreenService.java")),StandardCharsets.UTF_8);
    check(!screen.contains("ClipboardGattReceiver") && !screen.contains("new ImeGattClient"), "Projection must not compete for the text GATT or launch clipboard input");
    String ime = new String(Files.readAllBytes(Paths.get(root,"src/cn/qdd/screenbridge/QddInputMethodService.java")),StandardCharsets.UTF_8);
    int receive = ime.indexOf("byte[] response = session.receive(bytes);");
    int guarded = ime.indexOf("if (destroyed || revision != transportRevision || bluetooth != sender) return;", receive);
    int send = ime.indexOf("sender.send(response)", receive);
    check(receive >= 0 && guarded > receive && send > guarded,"A reentrant commit cannot send an old ACK on a replaced GATT");
    System.out.println("PASS IME registration and single production text receiver");
  }
}
