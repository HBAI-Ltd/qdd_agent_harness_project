export async function localApi(path,body,fetcher=fetch){
 const options={credentials:'same-origin',...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})};
 let response=await fetcher(path,options),data=await response.json();
 // The rejected request has not reached any cloud/SMS handler. Recover the local
 // cookie once before retrying that same request; never retry an upstream error.
 if(response.status===401&&data.code==='LOCAL_SESSION_REQUIRED'){
  const bootstrap=await fetcher('/',{credentials:'same-origin',cache:'no-store'});
  if(bootstrap.ok){response=await fetcher(path,options);data=await response.json();}
 }
 if(!response.ok){const error=new Error(data.message||'请求失败');error.code=data.code;throw error;}
 return data;
}
