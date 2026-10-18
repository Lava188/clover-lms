# Clover IELTS LMS

Monorepo cho hai lập trình viên: React/Vite trong `frontend`, NestJS CommonJS trong `backend`.
Backend dùng SQL trực tiếp qua `pg` (node-postgres), không dùng ORM.

## Cấu trúc dự án

```text
backend/
  migrations/        # SQL có thứ tự, được review và chạy thủ công
  src/
    config/          # Kiểm tra biến môi trường
    database/        # Connection pool và truy vấn SQL
    modules/health/  # API health và kiểm tra kết nối database
    app.module.ts    # Đăng ký các module
    main.ts          # Khởi động NestJS
frontend/
  src/
    app/             # Providers và router
    components/ui/   # UI dùng chung (shadcn)
    features/        # Thêm nghiệp vụ tại đây khi triển khai
    lib/             # Axios và helpers
    pages/           # Trang Home và Not Found
    App.tsx
    main.tsx
    index.css
```

Tên folder nghiệp vụ dùng chữ thường, ví dụ `students`. File NestJS dùng tên
`students.module.ts`, `students.controller.ts`, `students.service.ts`.
React components dùng PascalCase, ví dụ `StudentForm.tsx`.
Chỉ tạo thư mục hooks/types/layout/dto khi có code thực tế cần đặt vào đó.
`dist` là kết quả build và `node_modules` là dependencies, không chỉnh sửa hoặc commit.

## Cài đặt

Cần Node.js 24, npm, Git và tài khoản Neon PostgreSQL. Không cần Docker hoặc PostgreSQL local.

```powershell
git clone https://github.com/Lava188/clover-lms.git
cd clover-lms
nvm install 24
nvm use 24
npm ci
Copy-Item frontend/.env.example frontend/.env
Copy-Item backend/.env.example backend/.env
npm run dev
```

Chỉ copy `.env.example` khi chưa có `.env`, tránh ghi đè cấu hình cá nhân.

## Cấu hình Neon

Trong Neon Console, chọn project → Connect → branch cá nhân (`dev-a` hoặc `dev-b`), database và role.
Bật connection pooling, copy connection string vào `DATABASE_URL` trong `backend/.env`.
Giữ nguyên SSL parameters Neon cung cấp. Không đưa credentials vào frontend, Git hoặc log.

```dotenv
PORT=3000
CORS_ORIGIN=http://localhost:5173
DATABASE_URL=
```

`DIRECT_URL` không còn được backend sử dụng; có thể xóa dòng này khỏi `.env` cũ.
`frontend/.env` chỉ cần `VITE_API_URL=http://localhost:3000/api`.
Ứng dụng vẫn khởi động khi chưa có DATABASE_URL; database health khi đó trả 503.

## Chạy và kiểm tra

```powershell
npm run dev
npm run dev:frontend
npm run dev:backend
npm run build
npm run lint
npm run format:check
```

- Frontend: http://localhost:5173.
- API: http://localhost:3000/api/health.
- Database: http://localhost:3000/api/health/database.

```powershell
Invoke-RestMethod http://localhost:3000/api/health
Invoke-RestMethod http://localhost:3000/api/health/database
```

Database health chạy `SELECT 1`, chỉ trả `database: connected` khi kết nối thật thành công.
HTTP 503 nghĩa là cấu hình thiếu hoặc database không truy cập được; endpoint không kiểm tra bảng nghiệp vụ.
Không cần generate client trước khi build/chạy.

## Viết SQL trong NestJS

Import `DatabaseModule` vào module nghiệp vụ, inject `DatabaseService` trong service:

```typescript
import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../../database/database.service';

@Injectable()
export class UsersService {
  constructor(private readonly database: DatabaseService) {}

  async findByEmail(email: string) {
    const result = await this.database.query<{
      id: string;
      email: string;
      fullName: string;
    }>('SELECT "id", "email", "fullName" FROM "User" WHERE "email" = $1', [
      email,
    ]);
    return result.rows[0] ?? null;
  }
}
```

Luôn truyền giá trị người dùng qua `$1`, `$2` và mảng tham số, không nối chuỗi SQL.
Generic TypeScript chỉ mô tả kiểu dữ liệu, không tự kiểm tra dữ liệu runtime.
Pool được tái sử dụng và đóng khi ứng dụng shutdown. Truy vấn hiện có timeout 10 giây.
Không dùng nhiều lệnh `database.query()` để thực hiện transaction: transaction phải dùng cùng một client đã checkout và luôn release trong `finally`.

## SQL schema và làm việc nhóm

`backend/migrations/001_bootstrap_users.sql` là schema User/Role tạm thời tương đương nền tảng ban đầu.
File này chưa được chạy tự động và chỉ dành cho database phát triển mới, chưa có bảng tương ứng.
Nếu đã có bảng tạo trước đây, kiểm tra schema hiện hữu trước; không xóa/reset dữ liệu để chạy lại file.

Để áp dụng thủ công: xác nhận branch phát triển riêng trong Neon Console, mở SQL Editor,
review nội dung SQL rồi mới thực thi trên đúng branch. Không chạy trên `main`/`develop` khi chưa được người phụ trách xác nhận.
Không có migration runner hoặc lệnh deploy database tự động trong cấu hình này.

Khi thay đổi schema, thêm file SQL đánh số tiếp theo vào `backend/migrations/`, mở PR để review,
và ghi lại file đã áp dụng cho từng Neon branch. Không sửa file đã được áp dụng chung.
Nếu cần nhiều migration, thống nhất migration runner có bảng theo dõi phiên bản trước khi phát hành.

- Git `main`: ổn định; `develop`: tích hợp; `feature/*`: phát triển tính năng.
- Neon `main`: production-ready; `develop`: tích hợp; `dev-a`, `dev-b`: database riêng.
- Git branch và Neon branch không tự đồng bộ schema. Checkout Git không đổi DATABASE_URL.
- Sau pull dependency: `npm ci`. Sau pull SQL: review và áp dụng thủ công trên branch phù hợp.
- Mời cộng tác viên trên GitHub, bảo vệ main/develop và yêu cầu PR review.

Giữ một lockfile tại root; cài dependency bằng `npm install <package> -w backend` hoặc `-w frontend`.
Các thư mục features/modules hiện dành cho nghiệp vụ LMS giai đoạn tiếp theo.

## Tài liệu

- [node-postgres queries](https://node-postgres.com/features/queries)
- [node-postgres pooling](https://node-postgres.com/features/pooling)
