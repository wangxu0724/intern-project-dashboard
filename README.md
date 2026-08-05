# 实习生项目看板

基于飞书实习生工作表搭建的共享看板，支持年月、部门、紧急度和关键词筛选，以及 Excel/CSV/飞书公开链接导入和 Markdown/Excel 下载。

## 本地运行

```powershell
npm install
npm start
```

打开 `http://localhost:4173`。如需指定浏览器位置，可设置 `CHROME_PATH`；Windows 会自动使用本机 Edge 或 Chrome。

## 数据共享

看板数据保存在 `data/records.json`。任何访客导入新数据后，同一服务上的其他访客刷新页面即可看到更新。生产部署时应为 `data` 目录挂载持久磁盘。

## 公开部署

项目包含 `Dockerfile` 和 `render.yaml`，可直接连接 GitHub 仓库部署为 Render Web Service。默认使用免费实例；容器内已包含飞书链接导入所需的 Chromium，平台分配 `onrender.com` 域名后，任何人都可以通过该链接查看看板。

Render 免费实例使用临时磁盘。仓库中的 `data/records.json` 提供初始数据，运行期间的上传可供所有访客共享，但在重新部署后会恢复为仓库初始数据。需要永久保留每次上传时，可升级到支持持久磁盘的实例并将磁盘挂载到 `/app/data`。
