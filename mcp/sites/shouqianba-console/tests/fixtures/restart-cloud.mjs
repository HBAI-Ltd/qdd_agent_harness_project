// Child-process fixture only. Never imported by production server code.
import assert from 'node:assert/strict';
globalThis.fetch=async(url,options)=>{
 assert.equal(url.origin,'https://web-platforms-msp.shouqianba.com');
 const token=options.headers.Authorization?.slice(7);
 if(url.pathname.endsWith('refreshToken')){assert.equal(token,'synthetic-expired-restart-token');return Response.json({code:10000,data:{status:2,token:'synthetic-renewed-restart-token',valid_time:3600}});}
 assert.equal(url.pathname,'/api/login/ucUser/getCurrentUser');
 if(token==='synthetic-expired-restart-token')return Response.json({code:50201,msg:'synthetic expired'});
 assert(['synthetic-restart-token','synthetic-renewed-restart-token'].includes(token));assert.match(options.headers.Cookie,/restore_cookie=synthetic-persisted-cookie/);
 return Response.json({code:10000,data:{trade_user_info:{role:'super_admin',merchant_id:303,merchant_user_id:404},loginUserInfo:{name:'重启合成测试店'}}},{headers:{'Set-Cookie':'renewed_cookie=synthetic-new-cookie; Path=/; HttpOnly'}});
};
