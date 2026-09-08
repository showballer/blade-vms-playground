import type { Metadata } from "next";
import "@blade/ui/styles.css";
export const metadata: Metadata = {
  title: "BladeVMS · 三维台架结构力学特征测试系统",
  description: "旋转叶片测振与损伤检测管理平台",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
