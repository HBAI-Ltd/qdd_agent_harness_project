package android.net;
public class Network { private final int id; public Network(int id){this.id=id;} public boolean equals(Object other){return other instanceof Network && ((Network)other).id==id;} public int hashCode(){return id;} }
