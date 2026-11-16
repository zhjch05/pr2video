import { defineConfig } from "vitest/config"

export default defineConfig({
  resolve: { conditions: ["pr2video-source"] },
  ssr: { resolve: { conditions: ["pr2video-source"] } },
})
