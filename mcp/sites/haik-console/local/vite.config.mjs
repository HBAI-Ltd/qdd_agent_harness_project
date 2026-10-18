import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {fileURLToPath} from 'node:url';
export default defineConfig({root:fileURLToPath(new URL('./web',import.meta.url)),plugins:[react()],build:{outDir:fileURLToPath(new URL('../dist-local',import.meta.url)),emptyOutDir:true},resolve:{dedupe:['react','react-dom']}});
