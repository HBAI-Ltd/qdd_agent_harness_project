package android.net;
public class ConnectivityManager {
 public static final ConnectivityManager INSTANCE=new ConnectivityManager();
 public final java.util.Map<Network,LinkProperties> networks=new java.util.HashMap<>();
 public Network[] getAllNetworks(){return networks.keySet().toArray(new Network[0]);} public NetworkCapabilities getNetworkCapabilities(Network network){return networks.containsKey(network)?new NetworkCapabilities():null;} public LinkProperties getLinkProperties(Network network){return networks.get(network);} public void registerNetworkCallback(NetworkRequest request,NetworkCallback callback){}
 public static class NetworkCallback { public void onAvailable(Network network){} public void onLinkPropertiesChanged(Network network,LinkProperties properties){} public void onLost(Network network){} }
}
