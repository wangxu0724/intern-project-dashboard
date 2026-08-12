# 实习生项目看板

实习生工作安排看板，支持公开查看、筛选、Excel/CSV 导入、飞书表格链接导入和 Markdown/Excel 下载。

- 按年月、部门、紧急度和关键词筛选
- Excel/CSV 导入
- 飞书表格链接导入：授权后读取多个 Sheet，选择 Sheet 并预览前 8 行后导入
- Markdown/Excel 下载
- 桌面和手机端适配

## 本地运行

```powershell
npm start
```

打开 `http://localhost:4173`。

## 启用飞书链接导入

飞书授权需要服务端保存应用密钥，因此启用链接导入时使用 Render Web Service，不使用 GitHub Pages 作为授权回调地址。

在飞书开放平台创建应用并配置重定向地址：

`https://你的-render-域名.onrender.com/auth/feishu/callback`

在 Render 添加环境变量：

- `FEISHU_APP_ID`
- `FEISHU_APP_SECRET`
- `FEISHU_REDIRECT_URI`：上面的回调地址

应用需要申请读取云文档/电子表格的用户授权权限。部署完成后，打开 Render 提供的地址即可使用全部功能；GitHub Pages 地址仍可作为纯静态查看入口。

## 当前公开地址

`https://wangxu0724.github.io/intern-project-dashboard/`
