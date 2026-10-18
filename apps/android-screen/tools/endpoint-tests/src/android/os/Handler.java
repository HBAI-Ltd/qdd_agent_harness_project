package android.os;
import java.util.ArrayList;
import java.util.List;
public class Handler {
 private static final class Task { final Runnable runnable;final long due;Task(Runnable value,long time){runnable=value;due=time;} }
 private static final List<Task> tasks=new ArrayList<>();
 public Handler(Looper looper){}
 public boolean postDelayed(Runnable value,long delay){tasks.add(new Task(value,SystemClock.now+delay));return true;}
 public void removeCallbacks(Runnable value){tasks.removeIf(task->task.runnable==value);}
 public static int pending(){return tasks.size();}
 public static Runnable next(){return tasks.isEmpty()?null:tasks.get(0).runnable;}
 public static void reset(){tasks.clear();SystemClock.now=0;}
 public static void advance(long milliseconds){SystemClock.now+=milliseconds;for(;;){Task found=null;for(Task task:tasks)if(task.due<=SystemClock.now){found=task;break;}if(found==null)return;tasks.remove(found);found.runnable.run();}}
}
