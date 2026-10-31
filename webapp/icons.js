/* ==========================================================================
   SVG 线性图标集（单色 1.5px 描边，24x24 网格）
   规范要求：单色 + SVG + 同风格 + 同描边，禁止混 emoji
   ========================================================================== */
(function () {
  function svg(paths, size) {
    var s = size || 20;
    return '<svg viewBox="0 0 24 24" width="' + s + '" height="' + s + '" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" ' +
      'aria-hidden="true">' + paths + '</svg>';
  }
  window.PC_ICONS = {
    clock: function (s) { return svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.5 2"/>', s); },
    list: function (s) { return svg('<path d="M8 6h12M8 12h12M8 18h12"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>', s); },
    user: function (s) { return svg('<circle cx="12" cy="8" r="3.5"/><path d="M5 20c0-3.5 3.1-6 7-6s7 2.5 7 6"/>', s); },
    pin: function (s) { return svg('<path d="M12 21s7-5.5 7-11a7 7 0 1 0-14 0c0 5.5 7 11 7 11z"/><circle cx="12" cy="10" r="2.5"/>', s); },
    check: function (s) { return svg('<path d="M5 13l4 4L19 7"/>', s); },
    alert: function (s) { return svg('<circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><path d="M12 16h.01"/>', s); },
    chevronRight: function (s) { return svg('<path d="M9 6l6 6-6 6"/>', s); },
    chevronLeft: function (s) { return svg('<path d="M15 6l-6 6 6 6"/>', s); },
    calendar: function (s) { return svg('<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M8 3.5v3M16 3.5v3M3.5 10h17"/>', s); },
    settings: function (s) { return svg('<circle cx="12" cy="12" r="3"/><path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.5 1.5M16.5 16.5L18 18M18 6l-1.5 1.5M7.5 16.5L6 18"/>', s); },
    download: function (s) { return svg('<path d="M12 4v10"/><path d="M8 11l4 4 4-4"/><path d="M4 19h16"/>', s); },
    trash: function (s) { return svg('<path d="M4 7h16"/><path d="M9 7V5h6v2"/><path d="M6 7l1 13h10l1-13"/>', s); },
    briefcase: function (s) { return svg('<rect x="3.5" y="7" width="17" height="12" rx="2"/><path d="M9 7V5.5h6V7"/><path d="M3.5 12h17"/>', s); },
    refresh: function (s) { return svg('<path d="M4 12a8 8 0 0 1 13.6-5.7L20 8"/><path d="M20 4v4h-4"/><path d="M20 12a8 8 0 0 1-13.6 5.7L4 16"/><path d="M4 20v-4h4"/>', s); },
  };
})();
