# 地形材质融合预览 · Terrain Material Fusion Preview

一个可漫游的实时地形材质预览窗口：程序生成高度场形成山坡、沟谷与平台，按坡度、
海拔和手工权重融合岩石 / 土壤 / 植被三种测试材质，并用真实的 WebGL2 光照渲染，
而不是用二维颜色贴图冒充材质。

---

## 1. 怎样启动界面

需要 Node.js ≥ 18（项目零运行时依赖，浏览器端是原生 ES Module + WebGL2）。

```bash
# 1) 安装测试依赖（仅 Playwright / pngjs 用于自动化；界面本身不需要）
npm install

# 2) 启动静态服务器
npm start
#    → http://127.0.0.1:8080/
```

服务器是 `server.js`，也可指定端口 / 地址：

```bash
node server.js --port 8137 --host 0.0.0.0
```

> 界面必须通过 HTTP 打开，不能直接双击 `index.html`：浏览器会以 `file://`
> 协议拒绝加载 `import` 的模块脚本。启动后用浏览器访问上面的地址即可。

打开后：

- 左侧是 **内核 schema 生成的控件**（地形、材质规则、映射、光照、网格性能、相机）。
- 中间是可漫游的渲染窗口：拖拽旋转、Shift/右键平移、滚轮缩放、单击地表做权重探针。
- 右侧 **结果与权重检查**：探针点的原始权重 / 归一化权重、最终线性反照率、
  粗糙度、世界法线、回退材质状态，以及真实内存占用。
- 顶部可切换调试视图（最终光照、权重 RGB、各材质权重、零权重回退、法线、坡度、
  海拔、分块边界），并保存 / 载入参数、导出截图。

六张 **验证预设**：默认山坡、平面、陡壁、分块边缘、零权重区、权重视图。

---

## 2. 运行时架构

```
src/kernel/     纯数学内核（无 DOM / 无 GL / 无时钟），浏览器与 Node 共用
  math.js       确定性噪声、sRGB 转换、向量工具
  materials.js  材质调色板（sRGB 反照率、粗糙度、法线强度）
  terrain.js    高度场、权重融合与归一化、颜色/粗糙度/法线合成、分块网格、内存统计
  textures.js   程序化可平铺纹理（反照率+粗糙度、法线高度），mip 字节计算
  state.js      控件 schema、预设、参数校验与持久化
src/render/     WebGL2 渲染器
  gl.js         着色器/缓冲/纹理/矩阵工具
  shaders.js    GLSL ES 3.00：地形、天空、网格线
  renderer.js   GL 资源、相机、uniform、拾取、真实资源计数
src/app/        界面
  main.js       面板、控件、探针、持久化、渲染循环
  styles.css    布局与样式
server.js       零依赖静态服务器
tests/          单元测试 + E2E 截图基准
```

内核与着色器使用 **同一套公式**：GPU 逐像素重算权重，CPU 端用同一函数生成网格
顶点权重和探针读数，因此界面显示的数值与画面一致。

---

## 3. 高度场与材质融合

**高度场**（`terrain.js`）：domain-warp 的 ridged fBm 生成山脊，侵蚀通道切割沟谷，
分级平滑 riser 形成平台，另加一条可控的悬崖崖壁带和宽阔谷底。所有参数都有
`normalizeHeightParams` 的显式上下限。

**权重**（`evaluateRawWeights`）：

- **坡度**：`slopeTerm = smoothstep(slopeStart, slopeEnd, slope)`，陡处岩石、缓处土壤/植被。
- **海拔**：三档平滑带 `low / mid / high` 归一化为 `nLow/nMid/nHigh`，调制土壤与岩石。
- **手工权重**：三个 0..1 滑杆以加法叠加进原始权重（×3.2），可覆盖自动分布。
- **归一化**：`normalizeWeights` 是 **唯一的零和解析点**。权重逐样本归一到 Σ=1。
- **全零回退**：若 Σ ≤ 1e-8（含 NaN/负值/缺失），返回 `rock = 1` 的文档化默认
  “neutral basalt”，并置 `fallback = true`。颜色永远有定义，绝不出现 undefined/黑色。
  界面与调试视图都会明确标出回退状态。

**组合方式**：

| 通道 | 方法 |
| --- | --- |
| 颜色 | 线性光空间加权求和（纹理为 sRGB 反照率，采样时 `SRGB8_ALPHA8` 解码到线性） |
| 粗糙度 | 在感知粗糙度空间线性加权（存储于反照率贴图 alpha，本身是线性的） |
| 法线 | 每个材质解码切线空间法线 → 旋转到几何法线切帧 → 白化（reoriented/whiteout）加权求和 → 重归一化 → 半球钳制 |

法线 **不会** 把编码颜色直接当世界法线平均。解码、坐标旋转、投影切帧、重归一化
和半球翻正分别是独立步骤；单元测试覆盖了单位长度、半球方向以及“不是编码色平均”。

---

## 4. 纹理尺度与接缝

- **默认映射：三平面世界空间投影**。采样坐标是地表点的绝对米数
  （`p.xz / metersPerTile`），与网格顶点 index、UV、LOD 完全无关。因此移动相机或
  切换细分时花纹不滑动（E2E 中 LOD 192 vs 320 的 triplanar 画面逐像素一致）。
- **陡壁拉伸**：三平面按法线选择 X/Y/Z 投影并按 `sharpness` 加权混合，45° 混合带
  平滑过渡，避免陡壁上的单轴拉伸；平面 XZ 模式作为 A/B 对照，故意展示墙面的拉伸。
- **接缝处理**：所有纹理均由可平铺（periodic）噪声生成，用 `GL_REPEAT` +
  mipmap + 各向异性过滤采样；法线贴图用环绕中心差分，边缘行也是单位向量。
  三平面的拼缝只在 45° 混合带淡入淡出，没有可见硬缝。
- **网格 UV 模式（mode 2）** 保留为反面教材：贴图数量绑定网格细分，切换 LOD
  花纹会滑动（E2E 用像素差异量化了这一点）。

---

## 5. 真实内存占用

右侧面板与 HUD 显示的是 **实际资源字节数**，不是估算：

- GPU 网格缓冲 = 已上传的 position/normal/weights/index/line 缓冲字节之和。
- CPU 网格数组 = 上述 + 仅 CPU 持有的 UV 数组。
- GPU 纹理 = 6 张 RGBA8（3 材质 × 2 贴图）的完整 mip 链字节数。
- 绘制调用、本帧渲染三角形取自实际 `render()` 计数。

单元测试逐项核对 `meshMemory` 与 `Uint8Array/Float32Array.byteLength` 之和，
并验证 mip 链字节公式。

---

## 6. 测试与截图基准

```bash
npm test             # 33 个内核/状态单元测试（node:test）
npm run test:e2e     # 启动真实服务器 + 无头 WebGL2，比对截图基准与界面行为
npm run baselines    # 重新生成 tests/baselines/*.png
npm run check        # 语法检查 + 单元测试
```

E2E 会验证：应用无错误启动、画面非纯色、控件/预设/权重表/结果区/内存面板均有内容、
可见权重 Σ=1、单击移动探针、零权重区域触发回退且回退色有定义、非法参数被内核修正
并反馈到界面、JSON 与 localStorage 持久化往返、三平面跨 LOD 像素稳定、网格 UV 跨
LOD 滑动、分块网格权重归一，以及六张基准截图逐像素比对。

截图来自 `canvas.toDataURL()`（`preserveDrawingBuffer: true`），在 SwiftShader 下
是确定性的。基准存放在 `tests/baselines/`。

**无头环境字体**：容器缺少中文字体时截图中的中文标签会显示为方框；这不影响渲染
结果基准本身（只比较 WebGL 画布，不含 DOM 文字）。E2E 断言不依赖中文像素。

---

## 7. 环境说明

本仓库在无 root 的 Linux 容器中验证过。若 Playwright 自带的无头壳缺少
`libnspr4` / `libnss3` 等系统库，可执行一次（需要联网、下载到 `.cache/`）：

```bash
bash tools/linux-libs.sh
```

`tests/e2e/browser.mjs` 会自动把 `.cache/linux-libs` 加入 `LD_LIBRARY_PATH`。
WebGL2 使用 SwiftShader 软件渲染，因此截图结果不受宿主机 GPU 影响。
