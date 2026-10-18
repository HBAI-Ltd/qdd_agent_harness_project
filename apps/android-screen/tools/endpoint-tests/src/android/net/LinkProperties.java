package android.net;
public class LinkProperties { private final java.util.List<LinkAddress> addresses=new java.util.ArrayList<>(); public LinkProperties(String address)throws java.net.UnknownHostException{addresses.add(new LinkAddress(java.net.InetAddress.getByName(address)));} public java.util.List<LinkAddress> getLinkAddresses(){return addresses;} }
