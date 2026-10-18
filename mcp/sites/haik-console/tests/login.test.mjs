import {test,afterEach} from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from 'jsdom';
import React from 'react';
const dom=new JSDOM('<!doctype html><html><head></head><body></body></html>',{url:'http://localhost/'});
Object.assign(globalThis,{window:dom.window,document:dom.window.document,HTMLElement:dom.window.HTMLElement,IS_REACT_ACT_ENVIRONMENT:true});
const {render,screen,fireEvent,waitFor,cleanup,act}=await import('@testing-library/react');
const {default:LoginModal}=await import('../app/login-modal.tsx');
const originalFetch=globalThis.fetch;
afterEach(()=>{cleanup();globalThis.fetch=originalFetch;delete window.initAliyunCaptcha;});
function mount(){return render(React.createElement(LoginModal,{connected:true,onClose:()=>{},onConnected:()=>{}}));}
function sdk(){let options;window.initAliyunCaptcha=o=>{options=o;o.getInstance({destroy(){}});};return ()=>options;}
test('failed CAPTCHA script can be retried and configuration exists before loading',async()=>{
 mount();assert.deepEqual(window.AliyunCaptchaConfig,{region:'cn',prefix:'1jgloq'});
 let script=document.querySelector('script[data-haik-captcha]');assert.ok(script);
 await act(async()=>{fireEvent.error(script);});assert.match(screen.getByRole('alert').textContent,/无法加载/);
 await act(async()=>{fireEvent.click(screen.getByRole('button',{name:'重试人机验证'}));});
 script=document.querySelector('script[data-haik-captcha]');assert.ok(script);assert.equal(document.querySelectorAll('script[data-haik-captcha]').length,1);
 sdk();await act(async()=>{fireEvent.load(script);});assert.equal(screen.getByRole('button',{name:'获取验证码'}).disabled,false);
});
test('phone and code validation prevents malformed login calls',async()=>{
 sdk();mount();await waitFor(()=>assert.equal(screen.getByRole('button',{name:'获取验证码'}).disabled,false));
 let requests=0;globalThis.fetch=async()=>{requests++;return Response.json({});};
 fireEvent.change(screen.getByPlaceholderText('请输入手机号'),{target:{value:'123'}});
 fireEvent.change(screen.getByPlaceholderText('请输入验证码'),{target:{value:'12'}});
 assert.equal(screen.getByRole('button',{name:'登录并连接'}).disabled,true);
 fireEvent.click(screen.getByRole('button',{name:'获取验证码'}));assert.match(screen.getByRole('alert').textContent,/11 位/);assert.equal(requests,0);
});
test('CAPTCHA success sends one SMS and applies cooldown while duplicate clicks are blocked',async()=>{
 const options=sdk();mount();await waitFor(()=>assert.equal(screen.getByRole('button',{name:'获取验证码'}).disabled,false));
 const requests=[];globalThis.fetch=async(url,init)=>{requests.push(JSON.parse(init.body));return Response.json({sent:true});};
 fireEvent.change(screen.getByPlaceholderText('请输入手机号'),{target:{value:'13800000000'}});
 fireEvent.click(screen.getByRole('button',{name:'获取验证码'}));assert.equal(screen.getByRole('button',{name:'请完成人机验证'}).disabled,true);
 await act(async()=>{await options().success('verified-parameter');});
 assert.equal(requests.length,1);assert.equal(requests[0].action,'send_code');assert.equal(requests[0].captchaVerifyParam,'verified-parameter');
 assert.ok(screen.getByRole('button',{name:'60 秒后重发'}).disabled);
});
test('closed login dialog ignores a stale verification callback',async()=>{
 const options=sdk();const view=mount();await waitFor(()=>assert.equal(screen.getByRole('button',{name:'获取验证码'}).disabled,false));
 let requests=0;globalThis.fetch=async()=>{requests++;return Response.json({sent:true});};
 fireEvent.change(screen.getByPlaceholderText('请输入手机号'),{target:{value:'13800000000'}});fireEvent.click(screen.getByRole('button',{name:'获取验证码'}));
 const stale=options();view.unmount();await stale.success('verified-parameter');assert.equal(requests,0);
});
test('verification before entering phone is consumed only after explicitly requesting SMS',async()=>{
 const options=sdk();mount();await waitFor(()=>assert.equal(screen.getByRole('button',{name:'获取验证码'}).disabled,false));
 const requests=[];globalThis.fetch=async(url,init)=>{requests.push(JSON.parse(init.body));return Response.json({sent:true});};
 await act(async()=>{await options().success('preverified-parameter');});assert.equal(requests.length,0);
 fireEvent.change(screen.getByPlaceholderText('请输入手机号'),{target:{value:'13800000000'}});fireEvent.click(screen.getByRole('button',{name:'获取验证码'}));
 await waitFor(()=>assert.equal(requests.length,1));assert.equal(requests[0].captchaVerifyParam,'preverified-parameter');
});
test('failed login remains open and displays provider error',async()=>{
 sdk();let connected=0;render(React.createElement(LoginModal,{connected:true,onClose:()=>{},onConnected:()=>{connected++;}}));
 globalThis.fetch=async()=>Response.json({code:'SMS_INVALID',message:'验证码错误'},{status:502});
 fireEvent.change(screen.getByPlaceholderText('请输入手机号'),{target:{value:'13800000000'}});fireEvent.change(screen.getByPlaceholderText('请输入验证码'),{target:{value:'123456'}});
 fireEvent.submit(screen.getByRole('button',{name:'登录并连接'}).closest('form'));
 await waitFor(()=>assert.match(screen.getByRole('alert').textContent,/验证码错误/));assert.equal(connected,0);assert.ok(screen.getByRole('dialog'));
});
