# Clover IELTS LMS

Monorepo nền tảng cho hai lập trình viên. React/Vite trong `frontend`, NestJS CommonJS trong `backend`. Chưa triển khai nghiệp vụ LMS.

## Yêu cầu và cài đặt

- Node.js 24 (xem `.nvmrc`), npm đi kèm, Git.
- Tài khoản GitHub và Neon PostgreSQL. Không cần Docker hoặc PostgreSQL local.

```powershell
git clone <URL-repository-cua-nhom>
cd clover-lms
nvm install 24
nvm use 24
npm ci
Copy-Item frontend/.env.example frontend/.env
Copy-Item backend/.env.example backend/.env
npm run db:generate
npm run dev
```

Chỉ copy `.env.example` khi chưa có `.env`; giữ nguyên file cấu hình cá nhân đã có.

Frontend: http://localhost:5173. API: http://localhost:3000/api/health.
Trang chủ hiển thị trạng thái frontend, backend và database với loading, error và nút thử lại. Router có trang 404.
API có thể chạy khi chưa cấu hình database; `/api/health/database` trả HTTP 503 trong trường hợp này.

## Neon

Tạo project Neon và các database branch `main`, `develop`, `dev-a`, `dev-b` trong Neon Console. Mỗi lập trình viên chọn branch riêng.
Trong `backend/.env`, điền:

- `DATABASE_URL`: connection string **pooled** của branch cá nhân.
- `DIRECT_URL`: connection string **direct**, không có pooler, của **cùng branch**.

Sao chép nguyên SSL parameters từ Neon. Không đặt các URL này vào frontend hoặc biến `VITE_*`. Không commit `.env` hoặc đưa credentials vào issue/log.
`frontend/.env` chỉ cần `VITE_API_URL=http://localhost:3000/api`.
Backend đọc `PORT` (mặc định 3000) và `CORS_ORIGIN` (mặc định http://localhost:5173).
Lệnh workspace chạy trong thư mục từng ứng dụng nên `.env` được đọc tại đó.

## Lệnh thường dùng

```powershell
npm run dev
npm run dev:frontend
npm run dev:backend
npm run build:frontend
npm run build:backend
npm run lint
npm run format:check
npm run format
npm run db:validate
npm run db:generate
```

`build:api` tự generate Prisma Client trước khi biên dịch. Client sinh vào `backend/src/generated/prisma` và không được commit.
Prisma 7 dùng `prisma.config.ts` cho URL migration; generator `prisma-client` xuất CommonJS tương thích NestJS.
Schema User/Role hiện tại chỉ là bootstrap, chưa phải ERD chính thức.

## Migration an toàn

Chưa có migration nào được chạy tự động. Trước khi tạo/chạy migration, kiểm tra cả hai URL đang trỏ tới đúng dedicated development branch và xác nhận trong Neon Console.

Sau khi xác nhận branch cá nhân:

```powershell
npm run db:migrate -w backend -- --name init
```

Review SQL trong `backend/prisma/migrations`, commit schema và migration cùng nhau. Không commit generated client.
Để áp dụng migration đã review lên một branch được phép:

```powershell
npm run db:deploy
```

Không chạy migration trên Neon `main` hoặc `develop` khi chưa có xác nhận rõ ràng của người phụ trách. Không dùng `prisma db push` trên database chung/production. Không đồng ý reset database có dữ liệu cần giữ. Deploy không tự tạo migration; cần tạo và review migration trên branch cá nhân trước.

## Kiểm tra kết nối

Khi API đang chạy:

```powershell
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:3000/api/health/database
```

Health trả `status: ok` và `message: IELTS LMS API is running`.
Database health thực thi `SELECT 1`; chỉ trả `database: connected` khi kết nối thật thành công. HTTP 503 nghĩa là cấu hình thiếu hoặc database không truy cập được. Endpoint này không kiểm tra bảng User đã được migrate hay chưa.

## Làm việc nhóm

- Git `main`: ổn định; `develop`: tích hợp; `feature/*`: phát triển tính năng.
- Tạo feature branch từ develop, mở pull request vào develop và nhờ người còn lại review. Đưa develop vào main qua PR khi ổn định.
- Trên GitHub, mời cộng tác viên, bảo vệ main/develop, yêu cầu review trước merge; cấu hình CI build/lint khi nhóm sẵn sàng.
- Neon `main`: production-ready; `develop`: tích hợp; `dev-a` và `dev-b`: database riêng cho mỗi người.
- **Git branch và Neon branch không tự đồng bộ migration.** Checkout Git không đổi DATABASE_URL; mỗi người phải chọn đúng Neon branch và áp dụng migration được review.
- Sau pull thay đổi dependency: `npm ci`. Sau pull thay đổi schema: `npm run db:generate`, rồi áp dụng migration đã review lên database cá nhân.

Giữ một `package-lock.json` ở root và cài dependency từ root với `-w frontend` hoặc `-w backend`. Các thư mục features/modules là chỗ đặt nghiệp vụ trong giai đoạn tiếp theo.

## Tài liệu cấu hình

- [Prisma 7 và driver adapters](https://www.prisma.io/docs/guides/upgrade-prisma-orm/v7)
- [shadcn/ui cho Vite](https://ui.shadcn.com/docs/installation/vite)
- [NestJS configuration](https://docs.nestjs.com/application/configuration)
