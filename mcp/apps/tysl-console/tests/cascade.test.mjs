import test from 'node:test';
import assert from 'node:assert/strict';
import {TyslCloud,CloudError} from '../lib/cloud.mjs';

function client(respond){const cloud=new TyslCloud();cloud.post=respond;return cloud;}
const directory=(id,extra={})=>({id,regionType:2,treeType:2,hasChildren:false,havDevice:1,...extra});

test('cascade follows evidenced tree type and directory IDs, then merges duplicate device codes',async()=>{
  const calls=[];
  const cloud=client(async(path,body)=>{
    calls.push({path,body});
    if(path.endsWith('index-list'))return {returnList:[{deviceCode:'same',deviceName:'首页名称',onlineStatus:1,deviceScope:'B'}],isLastPage:true};
    if(path.endsWith('getRegionWithList'))return body.regionId?[directory(2,{regionCode:'region-code'})]:[directory(1,{havDevice:0,hasChildren:true})];
    return {total:2,deviceBaseInfoVOS:[{deviceCode:'same',deviceName:'级联同名',onlineStatus:true},{deviceCode:'cascade-only',deviceName:'另一台',onlineStatus:true}]};
  });
  const devices=await cloud.listDevices();
  assert.equal(devices.length,2);
  assert.equal(devices[0].deviceName,'首页名称');
  assert.equal(devices[0]._regionName,'自有与分享 · 来自级联');
  assert.equal(devices[1].deviceScope,'C');
  assert.deepEqual(calls[1].body,{treeType:'2',regionType:0,useType:0});
  assert.deepEqual(calls[2].body,{treeType:'2',regionId:'1',regionType:0,useType:0});
  assert.deepEqual(calls[3].body,{treeType:'2',regionId:'2',regionCode:'region-code',isIotDevice:0,hasChildDevices:0,isTraversal:0,pageNo:1,pageSize:100});
});

test('cascade pagination follows actual records even when the server caps page size',async()=>{
  const pages=[];
  const cloud=client(async(path,body)=>{
    if(path.endsWith('getRegionWithList'))return [directory(1)];
    pages.push(body.pageNo);
    return {total:3,pageSize:1,deviceBaseInfoVOS:[{deviceCode:'device-'+body.pageNo}]};
  });
  assert.equal((await cloud.listCascadeDevices()).length,3);
  assert.deepEqual(pages,[1,2,3]);
});

test('repeated directory edges do not loop and unsafe integer IDs are rejected',async()=>{
  let calls=0;
  const cloud=client(async()=>{calls++;return [directory(1,{hasChildren:true,havDevice:0})];});
  assert.deepEqual(await cloud.listCascadeDevices(),[]);
  assert.equal(calls,2);
  cloud.post=async()=>[directory(Number.MAX_SAFE_INTEGER+1)];
  await assert.rejects(cloud.listCascadeDevices(),{code:'INVALID_REGION'});
});

test('unavailable cascade preserves the usable index list with an explicit warning',async()=>{
  const cloud=client(async path=>{
    if(path.endsWith('index-list'))return {returnList:[{deviceCode:'a'}],isLastPage:true};
    throw new CloudError('TEST_ERROR','unavailable');
  });
  assert.equal((await cloud.listDevices()).length,1);
  assert.equal(cloud.listWarnings.length,1);
  cloud.post=async path=>path.endsWith('index-list')?{returnList:[],isLastPage:true}:null;
  await assert.rejects(cloud.listDevices(),{code:'INVALID_REGION_LIST'});
});
