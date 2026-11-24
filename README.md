# Lịch Hẹn Nhóm

Web nhỏ để cả nhóm điền lịch rảnh theo tuần, không cần đăng nhập. Ai sửa thì máy khác thấy ngay (đồng bộ trực tiếp qua Socket.IO).

- Lịch theo tuần: Sáng / Chiều / Tối, mỗi người một cột, cột cuối đếm số người rảnh.
- 5 trạng thái mặc định: Rảnh, Bận rùi, Về quê, Quê (Rảnh), Quê (Bận rùi). Thêm, sửa tên, đổi màu hoặc xoá trong **⚙ Cài đặt**, hoặc bấm “＋ Trạng thái khác” ngay trong ô.
- Thêm / xoá / đổi tên / đổi thứ tự thành viên.
- **Kỉ niệm** gắn vào từng ngày (chữ + tối đa 10 ảnh, ảnh tự thu nhỏ trước khi tải lên), có tab xem toàn bộ và banner “Ngày này năm trước”. Ảnh được lưu chung database với lịch (bảng `images`).
- Phải chọn **Bạn là** trước khi sửa. Mọi thay đổi ghi vào **📜 Lịch sử thay đổi** (300 mục gần nhất).
- Mọi thao tác xoá đều có popup hỏi lại.
- Nút **Chốt kèo & Copy** copy tóm tắt khung giờ đẹp nhất để dán vào nhóm chat.

## Chạy trên máy

```bash
npm install
npm start
```

Mở http://localhost:3000. Dữ liệu lưu ở `data/db.json`.

## Deploy lên Render

1. Đẩy thư mục này lên một repo GitHub.
2. Trên Render: **New → Blueprint** rồi chọn repo (Render đọc file `render.yaml`), hoặc **New → Web Service** với:
   - Build command: `npm install`
   - Start command: `npm start`
3. **Quan trọng – để không mất dữ liệu:** ổ đĩa của gói Render free bị xoá mỗi lần redeploy hoặc khi service ngủ rồi thức dậy. Hãy tạo một database Postgres miễn phí (ví dụ [Neon](https://neon.tech) hoặc Supabase), copy connection string rồi đặt vào biến môi trường `DATABASE_URL` của service. App tự tạo bảng khi khởi động.
   - Postgres của chính Render cũng dùng được (dán *Internal Database URL*), nhưng gói free của Render Postgres sẽ hết hạn sau một thời gian.

Gói free sẽ ngủ sau khoảng 15 phút không ai truy cập; lần mở đầu tiên sau đó mất khoảng 30–60 giây để thức dậy.

Sao lưu: **⚙ Cài đặt → Tải bản sao lưu dữ liệu**, hoặc mở `/api/export`.
