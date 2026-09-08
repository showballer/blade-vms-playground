import type { NextConfig } from "next";
const config: NextConfig = {
  transpilePackages: ["@blade/ui"],
  serverExternalPackages: ["mysql2", "exceljs"],
  poweredByHeader: false,
};
export default config;
