// Local policy, separate from the upstream lease: one attempt per six hours.
export class SessionKeeper {
  constructor({runtime,now=Date.now,setTimer=setTimeout,clearTimer=clearTimeout,intervalMs=6*3600000,record=async()=>{}}={}){
    this.runtime=runtime;this.now=now;this.setTimer=setTimer;this.clearTimer=clearTimer;this.intervalMs=intervalMs;
    this.record=record;
    this.timer=null;this.running=null;this.started=false;this.generation=0;this.failures=0;this.state='idle';this.lastAttemptAt=null;this.lastSuccessAt=null;this.lastError=null;this.nextCheckAt=null;
  }
  status(){return {enabled:!!this.runtime.nativeClient&&this.runtime.session?.authSource==='apk',state:this.state,intervalMs:this.intervalMs,lastAttemptAt:this.lastAttemptAt,lastSuccessAt:this.lastSuccessAt||this.runtime.session?.lastVerifiedAt||null,lastError:this.lastError,nextCheckAt:this.nextCheckAt};}
  start(){if(this.started)return this.running;this.started=true;this.generation++;return this.run();}
  stop(){this.started=false;this.generation++;if(this.timer!==null)this.clearTimer(this.timer);this.timer=null;this.nextCheckAt=null;}
  schedule(delay){if(!this.started)return;if(this.timer!==null)this.clearTimer(this.timer);this.nextCheckAt=this.now()+delay;this.timer=this.setTimer(()=>{this.timer=null;this.nextCheckAt=null;void this.run();},delay);this.timer?.unref?.();}
  run(){
    if(this.running)return this.running;
    const generation=this.generation;
    const task=(async()=>{
      let delay=this.intervalMs;
      if(!this.runtime.nativeClient||!this.runtime.session?.ucToken||this.runtime.session.authSource!=='apk'){
        this.state='idle';this.lastError=null;this.failures=0;
      }else{
        const originalToken=this.runtime.session.ucToken;
        this.state='checking';this.lastAttemptAt=this.now();
        try{
          await this.runtime.keepAlive();
          if(generation!==this.generation)return;
          this.state='healthy';this.lastSuccessAt=this.now();this.lastError=null;this.failures=0;
        }catch(e){
          if(generation!==this.generation)return;
          this.lastError=/^[A-Z0-9_]{1,64}$/.test(e.code||'')?e.code:'KEEPALIVE_UNAVAILABLE';
          if(!this.runtime.session?.ucToken){this.state='relogin_required';this.failures=0;}
          else{this.state='retrying';delay=[60000,300000,900000,3600000,this.intervalMs][Math.min(this.failures++,4)];}
        }
        try{await this.record({at:this.now(),ok:this.state==='healthy',errorCode:this.lastError,expiresAt:this.runtime.status().lease?.expiresAt??null,tokenChanged:!!this.runtime.session?.ucToken&&this.runtime.session.ucToken!==originalToken});}catch{}
      }
      if(generation===this.generation)this.schedule(delay);
    })();
    this.running=task;task.finally(()=>{if(this.running===task)this.running=null;}).catch(()=>{});return task;
  }
}
