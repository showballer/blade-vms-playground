import { PRODUCT_NAME } from "@blade/ui/product-name";
import type { Metadata } from "next";
import "@blade/ui/styles.css";
export const metadata: Metadata = {
  title: `BladeVMS · ${PRODUCT_NAME}`,
  description: "旋转叶片测振与损伤检测管理平台",
  icons: { icon: "/brand/app-icon.png" },
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
