# 人选天选论 · 后端

基于 Node.js + Express + Prisma + MySQL 的后端API服务。

## 技术栈

- **运行时**: Node.js 18+
- **框架**: Express 4
- **语言**: TypeScript
- **ORM**: Prisma 5
- **数据库**: MySQL 8
- **认证**: JWT + 短信验证码
- **短信**: 阿里云短信服务

## 项目结构

```
src/
├── index.ts                  # 应用入口
├── admin/
│   └── index.html            # 管理后台（单页应用）
├── config/
│   ├── database.ts           # Prisma客户端
│   └── env.ts                # 环境变量配置
├── controllers/
│   ├── auth.controller.ts    # 用户认证
│   ├── article.controller.ts # 文章管理
│   ├── diary.controller.ts   # 日记管理
│   └── dashboard.controller.ts # 管理后台数据
├── middleware/
│   ├── auth.ts               # JWT认证中间件
│   └── errorHandler.ts       # 全局错误处理
├── routes/
│   ├── auth.routes.ts        # 认证路由
│   ├── article.routes.ts     # 文章路由
│   ├── diary.routes.ts       # 日记路由
│   └── admin.routes.ts       # 管理后台路由
├── services/
│   └── sms.service.ts        # 短信验证码服务
└── utils/
    ├── response.ts           # 统一响应格式
    ├── jwt.ts                # JWT工具
    └── ip.ts                 # IP解析工具
```

## API 接口

### 认证
- `POST /api/auth/send-code` - 发送验证码
- `POST /api/auth/login` - 登录/注册
- `POST /api/auth/set-pin` - 设置PIN码
- `GET /api/auth/me` - 获取用户信息

### 文章
- `GET /api/articles` - 文章列表
- `GET /api/articles/:id` - 文章详情

### 日记
- `POST /api/diaries` - 创建日记
- `GET /api/diaries` - 日记列表
- `GET /api/diaries/:id` - 日记详情
- `GET /api/diaries/checkins` - 打卡数据
- `GET /api/diaries/stones` - 石头收藏

### 管理后台
- `GET /admin` - 管理后台页面
- `GET /api/admin/dashboard/overview` - 数据总览
- `GET /api/admin/dashboard/ip-distribution` - IP分布
- `GET/POST/PUT/DELETE /api/admin/articles` - 文章CRUD
- `GET /api/admin/users` - 用户列表

## 部署

```bash
# 安装依赖
npm install

# 生成Prisma客户端
npx prisma generate

# 推送数据库结构
npx prisma db push

# 开发模式
npm run dev

# 构建
npm run build

# 生产运行
npm start
```

## 环境变量

复制 `.env.example` 为 `.env` 并填写配置：

```env
DATABASE_URL=mysql://user:pass@host:3306/rxtxl
JWT_SECRET=your-secret-key
ALIYUN_SMS_ACCESS_KEY_ID=your-key
ALIYUN_SMS_ACCESS_KEY_SECRET=your-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=your-admin-password
```
