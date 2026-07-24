import '../App.css'

// Shown when liff.init() never resolved, so the app proper has no SDK to talk
// to. Deliberately dependency-free: whatever broke, this still has to render.
function BootFailure({ message }: { message: string }) {
  return (
    <main className="app">
      <h1>HRM</h1>
      <div className="card error">
        <p className="headline">เปิดแอปไม่สำเร็จ</p>
        <p className="detail">{message}</p>
        <p className="hint">
          หน้านี้ต้องเปิดผ่านแอป LINE — ถ้าเปิดจากเบราว์เซอร์ตรง ๆ จะขึ้นข้อความนี้
        </p>
      </div>
    </main>
  )
}

export default BootFailure
