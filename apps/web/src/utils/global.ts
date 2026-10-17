import { ElMessage } from "element-plus/es/components/message/index";
import axios from "./axios";

declare global {
  interface Window {
    $message: typeof ElMessage;
    $axios: typeof axios;
  }
}

window.$message = ElMessage;
window.$axios = axios;
