import type { MetadataRoute } from "next";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/api/", "/project/", "/view/", "/admin/", "/inbox"],
    },
    sitemap: "https://stripboard-editor.com/sitemap.xml",
  };
}
