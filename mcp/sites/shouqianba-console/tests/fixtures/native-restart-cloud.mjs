// Imported only by the isolated restart test process; blocks all real upstream access.
import assert from 'node:assert/strict';
globalThis.fetch=async(url,options)=>{
 assert.equal(url.origin,'https://mapi.shouqianba.com');assert.equal(options.headers.Authorization,undefined);assert.equal(options.headers['Shouqianba-Client'],'shouqianba-app-native');assert.equal(options.headers.device_id,'synthetic-native-restart-device');
 const token=url.searchParams.get('token');assert(token.startsWith('synthetic-native-restart-token-'));assert(token.length>40);
 if(url.pathname==='/v5/ucToken/refreshToken'){assert.equal(url.searchParams.get('threshold'),'86400');return Response.json({code:10000,data:{status:2,token:token+'r'}});}
 assert.equal(url.pathname,'/V2/Account/get');assert.equal(url.searchParams.getAll('token').length,2);assert.equal(token.at(-1),'r');
 return Response.json({code:10000,data:{admin:{merchant_id:303,merchant_user_id:404,role:'super_admin'},merchant:{id:303,sn:'S303',name:'App重启合成商户'},store_list:[]}});
};
