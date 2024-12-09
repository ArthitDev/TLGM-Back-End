const routes = {
  endpoints: [
    {
      path: "/",
      method: "GET",
      description: "แสดงรายการ endpoints"
    },
    {
      path: "/api/v1/register",
      method: "POST",
      description: "เส้นทางสำหรับการลงทะเบียน"
    },
    {
      path: "/api/v1/login",
      method: "POST",
      description: "เส้นทางสำหรับการเข้าสู่ระบบ"
    },
    {
      path: "/api/v1/check-auth",
      method: "GET",
      description: "ตรวจสอบสถานะการล็อกอิน"
    },
    {
      path: "/api/v1/logout",
      method: "POST",
      description: "ออกจากระบบ"
    },
    {
      path: "/api/v1/profile",
      method: "GET",
      description: "ดึงข้อมูลส่วนตัวของผู้ใช้"
    },
    {
      path: "/api/v1/profile",
      method: "PUT",
      description: "อัพเดทข้อมูลส่วนตัวของผู้ใช้"
    },
    {
      path: "/api/v1",
      method: "PUT",
      description: "อัพเดทข้อมูลส่วนตัวของผู้ใช้"
    },
    {
      path: "/api/v1",
      method: "PUT",
      description: "Resive group"
    },
    {
      path: "/api/v1",
      method: "POST",
      description: "Resive group"
    },
    {
      path: "/api/v1",
      method: "DELETE",
      description: "Resive group"
    },
    {
      path: "/api/v1",
      method: "PUT",
      description: "Sanding group"
    },
    {
      path: "/api/v1",
      method: "POST",
      description: "Sanding group"
    },
    {
      path: "/api/v1",
      method: "DELETE",
      description: "Sanding group"
    }

  ]
};

module.exports = routes; 
