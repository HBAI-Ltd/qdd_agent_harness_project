import { MessagePlugin } from "tdesign-vue-next";
import axios from "./axios";

declare global {
  interface Window {
    $message: typeof MessagePlugin;
    $axios: typeof axios;
  }
}

window.$message = MessagePlugin;
window.$axios = axios;
