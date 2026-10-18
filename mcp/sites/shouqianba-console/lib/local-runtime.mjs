import {CredentialStore} from './credentials.mjs';
import {NativeCloudClient} from './native-cloud.mjs';
import {Runtime} from './runtime.mjs';

export async function openLocalRuntime(root){
  const credentials=await new CredentialStore({root}).init();
  const {nativeProfile}=credentials.snapshot();
  const nativeClient=nativeProfile?new NativeCloudClient({profile:nativeProfile}):null;
  const runtime=await new Runtime({vault:credentials.file,nativeClient,nativeDevice:nativeProfile?.device,...credentials.sessionStorage()}).init();
  return {credentials,runtime};
}
