# ตั้งค่า ART CRM บน Windows (ฟรี ไม่ใช้บัตร)

เครื่องนี้จะเป็นเซิร์ฟเวอร์ของทีม ต้องเปิดและต่ออินเทอร์เน็ตตลอด

## 1. ติดตั้งโปรแกรม
1. **Node.js 18 ขึ้นไป** จาก https://nodejs.org (เลือก LTS)
2. **Git** จาก https://git-scm.com (ถ้ายังไม่มี)
3. **Tailscale** จาก https://tailscale.com/download แล้วสมัครบัญชีฟรีด้วยอีเมล
4. เปิด Funnel: เข้า https://login.tailscale.com/admin/dns แล้วเปิด **HTTPS Certificates** และเข้า https://login.tailscale.com/admin/acls แล้วเพิ่มสิทธิ์ `funnel` ให้ผู้ใช้ของคุณตามหน้าจอแนะนำ

## 2. ดึงโค้ดและรันสคริปต์
เปิด PowerShell แล้วรัน:
```powershell
git clone -b claude/art-crm-mobile-sales-b6yzpb https://github.com/havancrm/havancrm.git
cd havancrm
powershell -ExecutionPolicy Bypass -File scripts\windows\setup.ps1
```
สคริปต์จะ
- สร้างรหัสซิงก์แบบสุ่มและเก็บในบัญชีผู้ใช้ของ Windows (ตัวแปร `ARTCRM_SYNC_TOKEN`)
- ตั้งงานให้เซิร์ฟเวอร์เริ่มเองทุกครั้งที่เข้าสู่ระบบ และเริ่มใหม่อัตโนมัติถ้าหยุด
- เปิด Tailscale Funnel ที่พอร์ต 8080

## 3. หา URL และตรวจสอบ
```powershell
tailscale funnel status
```
จะได้ URL แบบ `https://<ชื่อเครื่อง>.<tailnet>.ts.net` เปิด `<URL>/api/health` ในเบราว์เซอร์ ต้องได้ `{"ok":true,...}`

## 4. ดูรหัสซิงก์
Settings > System > Environment variables > User variables > `ARTCRM_SYNC_TOKEN`
ไม่ต้องแชร์รหัสนี้ทางแชต ใส่ในแอปเท่านั้น

## 5. ตั้งค่าบนมือถือ (ทำทีละเครื่อง: Samsung S26 Ultra และ iPhone 17 Pro Max)
1. เปิด URL ใน Chrome (Android) หรือ Safari (iPhone) แล้วเพิ่มลงหน้าจอโฮม
2. เปิดแอป → หลังบ้าน → ตั้งค่า → แท็บระบบ → ใส่ URL และรหัสซิงก์ → บันทึกและซิงก์ตอนนี้
3. ทำเช็กลิสต์ใน `docs/PHONE_TEST.md`

## ดูแลระบบ
- **หยุดเซิร์ฟเวอร์:** `Stop-ScheduledTask -TaskName "ART CRM Server"`
- **เริ่มใหม่:** `Start-ScheduledTask -TaskName "ART CRM Server"`
- **ข้อมูลและสำรอง:** อยู่ในโฟลเดอร์ `havancrm\data` (`db.json` และ `backups\` ที่สำรองทุกวัน เก็บ 30 วัน) คัดลอกโฟลเดอร์นี้ไปเก็บที่อื่นทุกสัปดาห์
- **อัปเดตโค้ด:** `git pull` แล้วรันสคริปต์ setup ใหม่ หรือ `Stop-ScheduledTask` แล้ว `Start-ScheduledTask`

## ข้อจำกัด
- ถ้าเครื่องปิดหรือไม่ต่ออินเทอร์เน็ต แอปบนมือถือยังใช้งานในเครื่องได้ แต่จะซิงก์ไม่ได้จนกว่าเครื่องนี้จะกลับมา
- งานตั้งเวลาทำงานเมื่อผู้ใช้เข้าสู่ระบบ ตั้งให้ Windows ล็อกอินอัตโนมัติได้ถ้าต้องการให้ทำงานหลังรีสตาร์ท
- ตั้ง Windows Update ให้รีสตาร์ทในช่วงที่ไม่ใช้งาน (Settings > Windows Update > Active hours)
