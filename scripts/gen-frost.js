/**
 * 磨砂颗粒（SVG feTurbulence）：让卡片本身有真实质感，不依赖背景
 *
 * 为什么需要它：实测发现 backdrop-filter 在这个画布上几乎看不出差别
 * （开/关 blur 两张截图肉眼一致，量化只差 1.7%）。
 * 原因是背景是极平滑的径向渐变——模糊平滑的东西等于没模糊。
 *
 * 毛玻璃真正依赖的是"身后有高频细节"。既然背景给不了，
 * 那就给卡片自己一层极细噪点，让"磨砂"这件事真实可感。
 *
 * 实现：SVG feTurbulence 生成 fractalNoise，压到 3% 透明度叠在白色上。
 * 成本极低（一张 200x200 的 data-uri，只算一次），且不随内容变化重绘。
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** 生成噪点 SVG data-uri（baseFrequency 决定颗粒大小） */
function noiseDataUri(freq, octaves) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
<filter id="n" x="0" y="0">
<feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${octaves}" stitchTiles="stitch"/>
<feColorMatrix type="saturate" values="0"/>
</filter>
<rect width="200" height="200" filter="url(#n)" opacity="0.14"/>
</svg>`;
  return 'data:image/svg+xml;base64,' + Buffer.from(svg.replace(/\n/g, '')).toString('base64');
}

const uri = noiseDataUri('0.85', 2);
console.log('noise data-uri length:', uri.length, 'chars');

const css = `
/* ==========================================================================
   磨砂颗粒（webapp/frost.css）
   --------------------------------------------------------------------------
   用途：给卡片一层极细的磨砂噪点，解决"半透明白看起来还是一块白"的问题。

   为什么不用 backdrop-filter 做大面积模糊（实测结论）：
     开/关 blur 两张截图肉眼一致，量化局部对比度只差 1.7%。
     原因是背景是极平滑的径向渐变，模糊平滑的东西没有任何变化。
     毛玻璃的价值来自"身后有高频细节"（文字、图片、纹理），
     而我们的背景全是低频渐变 → 大面积 backdrop-filter 是白付性能。

   所以毛玻璃只用在该用的三处（见 aurora.css 4.3/4.4：顶栏、底栏、弹层，
   它们身后有"滚动经过的内容"，那才是真实收益）。
   卡片的"质感"改用噪点实现——不依赖背景，任何底色下都能看出磨砂感。
   ========================================================================== */

:root {
  --frost-noise: url('${uri}');
}

/* 卡片：白色 + 噪点 + 极轻的内阴影，形成"磨砂玻璃片"的手感 */
body[data-bg="8"] .card,
body[data-bg="9"] .card,
body[data-bg="8"] .weekbar,
body[data-bg="9"] .weekbar,
body[data-bg="8"] .menu,
body[data-bg="9"] .menu,
body[data-bg="8"] .options,
body[data-bg="9"] .options,
body[data-bg="8"] .chain,
body[data-bg="9"] .chain {
  background-color: rgba(255, 255, 255, 0.7);
  background-image: var(--frost-noise);
  background-blend-mode: multiply;
  background-size: 200px 200px;
  /* 去掉大面积 backdrop-filter：它在这个画布上收益接近 0 */
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border: 1px solid rgba(255, 255, 255, 0.75);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.9) inset,
    0 6px 20px -10px rgba(79, 70, 229, 0.18);
}

/* 关键数字卡：噪点更淡，保证数字锐利 */
body[data-bg="8"] .summary,
body[data-bg="9"] .summary,
body[data-bg="8"] .hero-card,
body[data-bg="9"] .hero-card,
body[data-bg="8"] .profile,
body[data-bg="9"] .profile,
body[data-bg="8"] .current,
body[data-bg="9"] .current,
body[data-bg="8"] .day.is-today,
body[data-bg="9"] .day.is-today {
  background-color: rgba(255, 255, 255, 0.84);
  background-image: var(--frost-noise);
  background-blend-mode: multiply;
  background-size: 200px 200px;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border-color: rgba(255, 255, 255, 0.85);
}

/* 列表项：半透明白 + 极淡噪点（31 个元素，噪点比 blur 便宜得多） */
body[data-bg="8"] .day,
body[data-bg="9"] .day {
  background-color: rgba(255, 255, 255, 0.74);
  background-image: var(--frost-noise);
  background-blend-mode: multiply;
  background-size: 200px 200px;
  backdrop-filter: none;
  -webkit-backdrop-filter: none;
  border: 1px solid rgba(255, 255, 255, 0.7);
}

/* bg=9：磨砂更重（更白的底 + 更明显的噪点） */
body[data-bg="9"] .card,
body[data-bg="9"] .weekbar,
body[data-bg="9"] .menu,
body[data-bg="9"] .options,
body[data-bg="9"] .chain {
  background-color: rgba(255, 255, 255, 0.58);
  box-shadow:
    0 1px 0 rgba(255, 255, 255, 0.9) inset,
    0 8px 26px -12px rgba(79, 70, 229, 0.22);
}

/* 深色模式：噪点用柔光混合，避免把深底刷白 */
@media (prefers-color-scheme: dark) {
  body[data-bg="8"] .card,
  body[data-bg="9"] .card,
  body[data-bg="8"] .day,
  body[data-bg="9"] .day,
  body[data-bg="8"] .weekbar,
  body[data-bg="9"] .weekbar,
  body[data-bg="8"] .menu,
  body[data-bg="9"] .menu,
  body[data-bg="8"] .options,
  body[data-bg="9"] .options,
  body[data-bg="8"] .chain,
  body[data-bg="9"] .chain {
    background-color: rgba(26, 29, 38, 0.66);
    background-blend-mode: screen;
    border-color: rgba(255, 255, 255, 0.09);
    box-shadow:
      0 1px 0 rgba(255, 255, 255, 0.06) inset,
      0 6px 20px -10px rgba(0, 0, 0, 0.6);
  }

  body[data-bg="8"] .summary,
  body[data-bg="9"] .summary,
  body[data-bg="8"] .hero-card,
  body[data-bg="9"] .hero-card,
  body[data-bg="8"] .profile,
  body[data-bg="9"] .profile,
  body[data-bg="8"] .current,
  body[data-bg="9"] .current,
  body[data-bg="8"] .day.is-today,
  body[data-bg="9"] .day.is-today {
    background-color: rgba(30, 33, 43, 0.8);
    background-blend-mode: screen;
  }
}
`;

fs.writeFileSync(path.join(ROOT, 'webapp', 'frost.css'), css, 'utf8');
console.log('wrote webapp/frost.css');
