# Excel 附件

Web 上传的 `.xlsx`、`.xls`、`.xlsm` 文件保留原始字节。助手通过 `read_attachment` 读取时，服务端将所有工作表转换为带工作表名称的 CSV 文本，保留单元格的显示值；不执行宏或重新计算公式。

每次最多返回 40,000 字符，剩余内容通过响应提示的 `offset` 继续读取。损坏或加密的文件返回读取错误，可另存为 XLSX 或 CSV 后重试。附件卡片点击仍下载原文件。

回归测试位于 `apps/cli/src/attachments.test.ts`，覆盖三种格式、多工作表、中文、引号及换行、空表、原文件下载、分段读取和损坏文件。

执行：

```sh
npm run typecheck
npm run build
node --test apps/cli/dist/attachments.test.js
```
