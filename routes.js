const routes = {
  endpoints: [
    {
      path: "/",
      method: "GET",
      description: "แสดงรายการ endpoints ทั้งหมด"
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
    }
  ]
};

module.exports = routes; 