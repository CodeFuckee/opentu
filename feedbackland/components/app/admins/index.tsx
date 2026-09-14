"use client";

import { AdminsInvite } from "./invite";
import { AdminsTable } from "./table";

export function Admins() {
  return (
    <div className="">
      <h2 className="h5 mb-6">管理员</h2>
      <div className="space-y-8">
        <AdminsInvite />
        <AdminsTable />
      </div>
    </div>
  );
}
