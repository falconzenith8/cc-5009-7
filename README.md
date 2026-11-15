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
  海拔、分块边界、顶点标记），并保存 / 载入参数、导出截图。

**地形融合的图形入口**（融合在预览窗口内真实执行，不存在固定数据冒充结果）：

- 顶部 **「重新执行地形融合」** 按钮：调用同一条真实内核管线
  （生成纹理 → 构建分块网格 → 上传 GPU → 重渲染），右侧面板的「融合执行」计数随之 +1。
- 顶部 **「迁移旧版工程(v3→v2)」** 按钮：把旧版 state 经真实适配层迁移到材质资产 v2，
  迁移记录写入日志，并立即重跑融合。
- 任意控件 / 预设 / 探针变更，以及载入旧工程，都会触发同一条融合管线。
- 右侧 **「材质资产版本与迁移」** 面板：显示资产版本、融合契约、构建锁校验结果、
  融合实际执行次数，以及追加式的迁移 / 回退日志。

六张 **验证预设**：默认山坡、平面、陡壁、分块边缘、零权重区、权重视图。

---

## 2. 运行时架构

```
src/kernel/     纯数学内核（无 DOM / 无 GL / 无时钟），浏览器与 Node 共用
  math.js       确定性噪声、sRGB 转换、向量工具
  materialPack.js   材质资产 v2 的权威声明：颜色空间、通道语义、权重归一规则、融合契约
  materials.js  材质调色板门面（从 v2 默认包派生 sRGB 反照率、粗糙度、法线强度）
  materialLoader.js  资产加载器：v2 直读 + 构建锁校验，旧版走真实迁移适配层
  materialMigration.js 旧贴图+配置联合转换器：缺通道补全、旧默认值差异、语义保留证据
  materialPack.js / assetLock.js  内容哈希构建锁（FNV-1a，canonical JSON）
  migrationJournal.js 追加式迁移 / 载入 / 回退日志（内存或 localStorage 存储）
  terrain.js    高度场、权重融合与归一化、颜色/粗糙度/法线合成、分块网格、内存统计
  textures.js   程序化可平铺纹理（反照率+粗糙度、法线高度），mip 字节计算
  state.js      控件 schema、预设、参数校验与持久化（state v4，兼容旧 v1–v3）
src/render/     WebGL2 渲染器
  gl.js         着色器/缓冲/纹理/矩阵工具
  shaders.js    GLSL ES 3.00：地形、天空、网格线（融合常量全部来自 uniform，无字面量）
  renderer.js   GL 资源、相机、uniform、拾取、真实资源计数
src/app/        界面
  main.js       面板、控件、探针、持久化、渲染循环、融合执行与资产面板
  styles.css    布局与样式
assets/         材质资产 v2 与其构建锁 terrain-material.lock.json
tools/migration/  命令行迁移辅助（CLI，仅辅助，图形入口才是主路径）
server.js       零依赖静态服务器
tests/          单元测试 + E2E 截图基准 + 迁移夹具/证据
```

内核与着色器使用 **同一套公式与同一份契约**：融合系数集中声明在
`materialPack.js` 的 `FUSION_CONTRACT_V2`，CPU（`terrain.js`）与 GLSL
（`shaders.js` 经 `glslFusionContract` 生成 `uFusionCoeffs` uniform）消费的是同一份
冻结常量，着色器内不存在硬编码系数。GPU 逐像素重算权重，CPU 端用同一函数生成网格
顶点权重和探针读数，因此界面显示的数值与画面一致；E2E 进一步把屏幕像素射线拾取回
地形 UV，与 CPU 契约逐点比对。

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

## 3a. 材质资产版本、联合迁移与构建锁

**为什么换版**：旧资产只隐式假定颜色空间与通道含义，且 CPU 与 GPU 各用一套略有
分歧的融合系数。材质资产 v2（`materialPack.js`，`assetVersion = 2`）把这些都改成
**显式声明**：

- **颜色空间**：反照率+粗糙度贴图内部格式 `SRGB8_ALPHA8`——RGB 是 sRGB 反照率、
  alpha 是线性粗糙度；法线+高度贴图 `RGBA8`——RGB 线性切线法线、A 线性高度。
- **通道语义**：每个材质的每个通道都带语义标签
  （albedo / roughness / tangentNormal / height / fusionWeight / vertexFlag），
  消费方必须经 `resolveChannel` 解析，不能再按位置猜测。
- **权重归一规则**：每顶点 `vec4` = 三个融合权重 + 离散顶点标记
  （0 地表 / 1 零权重回退 / 2 裙边），归一化方式显式声明为
  `partition-of-unity`，零和回退为 `rock = 1` 的 “neutral basalt”。
- **融合契约**：`FUSION_CONTRACT_V2` 是冻结的单一事实来源，CPU 与 GLSL 共用。

**联合迁移**（`materialMigration.js`）同时转换 **旧贴图与旧配置**，不是只改版本号：

- 缺通道 / 整张贴图缺失时，按 v2 声明的默认值补全（如缺粗糙度补线性 1.0、缺法线补
  `[128,128,255,128]`），每一处补全都计入 `channelsFilled` 并给出告警，**不允许默认值
  伪装成成功**。
- 记录旧默认值到新显式声明的逐项转换（`defaultsConverted`）。
- **语义保留证据**：在中坡、谷底、崖壁带、陡面、外坡等采样点上，分别用旧 v1 与新 v2
  系数计算归一化权重，给出每点权重偏差、坡度与回退状态，并附首末边界纹素的逐位一致性
  （boundary pixels）。迁移成功与否由这些证据支撑，而非仅看版本字段。
- `assertPackIsV2` 严格校验：只把版本号改成 2 却仍按旧通道解释的“元数据式换版”会被
  直接拒绝（带 `.problems`）。

**加载兼容**（`materialLoader.js`）：v2 资产直读并做构建锁校验；旧工程（state v1–v3）
自动走真实迁移适配层，迁移后同样校验锁，必要时可回退到默认 v2 包。旧 localStorage 键
也会被识别并迁移到当前 `terrain-fusion-preview-state-v4`。

**构建锁**（`assetLock.js` + `assets/terrain-material.lock.json`）：对规范化（键排序）
后的包做 FNV-1a 32 位内容哈希，锁文件记录 `contentHash / assetVersion / contractId /
weightNormalization`。加载时 `verifyPackAgainstLock` 比对实时哈希，任何篡改都会使校验
失败并在资产面板标红。

**迁移日志**（`migrationJournal.js`）：迁移、v2 载入、旧版载入、补全、拒绝、回退都写进
追加式日志（浏览器用 localStorage，Node 用内存存储），因此 **换版与回退均留记录**，
在右侧资产面板可见。

**命令行仅作辅助**。图形界面（上面的两个按钮）是地形融合的主入口；CLI 复用同一个内核
转换器，便于离线批量处理与产出证据文件：

```bash
node tools/migration/migrate-material-asset.mjs \
  --input tests/fixtures/legacy-v1-asset.json \
  --output tests/evidence/cli-migrated-v2.json \
  --lock assets/terrain-material.lock.json \
  --evidence tests/evidence/migration-evidence.json
```

CLI 会打印状态、补全通道数、默认值转换数、权重最大/平均偏差、陡坡采样点数、边界像素
一致性与锁哈希；被拒绝或锁校验失败时以非零码退出。夹具 `tests/fixtures/legacy-v1-asset.json`
覆盖了缺整张法线贴图、缺反照率 alpha、法线仅存 alpha 等情形；证据落在 `tests/evidence/`。

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
npm test             # 52 个内核/状态/迁移单元测试（node:test）
npm run test:e2e     # 启动真实服务器 + 无头 WebGL2，比对截图基准与界面行为
npm run baselines    # 重新生成 tests/baselines/*.png
npm run check        # 语法检查 + 单元测试
```

E2E 会验证：应用无错误启动、画面非纯色、控件/预设/权重表/结果区/内存面板均有内容、
可见权重 Σ=1、单击移动探针、零权重区域触发回退且回退色有定义、非法参数被内核修正
并反馈到界面、JSON 与 localStorage 持久化往返、三平面跨 LOD 像素稳定、网格 UV 跨
LOD 滑动、分块网格权重归一，以及六张基准截图逐像素比对。

资产换版相关的自动化还包括：

- 实时材质包为显式 v2、契约 id 与归一规则正确、构建锁对实时包校验通过；
- 「重新执行地形融合」确实跑内核管线并使执行计数 +1，且权重始终归一；
- 旧版 v3 工程经真实适配层迁移、写日志、在界面告警中给出补全数与语义保留证据，
  迁移后融合实际重跑；
- **GPU/CPU 融合一致性**：在「顶点标记」视图里只取真实地表纹素（排除裙边/回退），
  射线拾取回地形 UV，并在解析高度场与实际网格权重一致的采样点上，把权重 RGB 视图的
  原始线性像素与 CPU v2 契约逐点比对（平均误差与达标率双重断言），证明着色器用的是
  声明的 v2 契约而非旧的分歧常量。调试视图（权重/法线/坡度/海拔/顶点标记）输出原始
  线性值、绕过 sRGB 显示转换，因此屏幕 R 通道即真实权重。

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
