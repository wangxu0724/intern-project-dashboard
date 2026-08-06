(function () {
  "use strict";

  const STORAGE_KEY = "intern-dashboard-records-v1";
  const DEFAULT_YEAR = new Date().getFullYear();
  const MONTH_LABELS = ["一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

  const state = {
    records: [],
    view: "schedule",
    mergeMode: "replace",
    pendingFile: null,
  };

  const elements = {
    year: document.querySelector("#yearFilter"),
    month: document.querySelector("#monthFilter"),
    department: document.querySelector("#departmentFilter"),
    urgency: document.querySelector("#urgencyFilter"),
    search: document.querySelector("#searchInput"),
    scheduleBody: document.querySelector("#scheduleBody"),
    mobileList: document.querySelector("#mobileList"),
    empty: document.querySelector("#emptyState"),
    scheduleView: document.querySelector("#scheduleView"),
    overviewView: document.querySelector("#overviewView"),
    departmentBars: document.querySelector("#departmentBars"),
    urgencyBreakdown: document.querySelector("#urgencyBreakdown"),
    uploadDialog: document.querySelector("#uploadDialog"),
    fileInput: document.querySelector("#fileInput"),
    fileNameLabel: document.querySelector("#fileNameLabel"),
    confirmImport: document.querySelector("#confirmImport"),
    exportMenu: document.querySelector("#exportMenu"),
    exportButton: document.querySelector("#exportButton"),
    sourceLabel: document.querySelector("#sourceLabel"),
    toast: document.querySelector("#toast"),
  };

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function normalizeHeader(value) {
    return String(value ?? "")
      .trim()
      .replace(/[\s\u3000]/g, "")
      .replace(/[（(].*?[）)]/g, "")
      .toLowerCase();
  }

  function parseMonth(value, fallbackMonth) {
    const text = String(value ?? "").trim();
    let match = text.match(/(20\d{2})[年\-/\.](\d{1,2})/);
    if (match) return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}`;

    match = text.match(/(?:^|\D)(\d{1,2})月/);
    if (match) return `${DEFAULT_YEAR}-${String(Number(match[1])).padStart(2, "0")}`;
    return fallbackMonth || `${DEFAULT_YEAR}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
  }

  function normalizeDate(value) {
    if (!value) return "";
    if (value instanceof Date && !Number.isNaN(value.valueOf())) {
      return value.toISOString().slice(0, 10);
    }
    const text = String(value).trim().replace(/[\.\/年]/g, "-").replace("月", "-").replace("日", "");
    const match = text.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
    if (!match) return String(value).trim();
    return `${match[1]}-${String(Number(match[2])).padStart(2, "0")}-${String(Number(match[3])).padStart(2, "0")}`;
  }

  function urgencyNumber(value) {
    const text = String(value ?? "");
    const stars = (text.match(/⭐/g) || []).length;
    if (stars) return Math.min(5, stars);
    const number = Number(text.match(/[1-5](?:\.\d+)?/)?.[0]);
    return Number.isFinite(number) ? Math.max(1, Math.min(5, Math.round(number))) : 3;
  }

  function findColumn(headers, aliases) {
    return headers.findIndex((header) => aliases.some((alias) => header.includes(alias)));
  }

  function detectHeaderRow(matrix) {
    const keywords = ["姓名", "部门", "岗位", "学校", "入职", "工作安排", "项目紧急度", "带教"];
    let bestIndex = 0;
    let bestScore = -1;

    matrix.slice(0, 20).forEach((row, index) => {
      const joined = row.map(normalizeHeader).join("|");
      const score = keywords.reduce((total, keyword) => total + (joined.includes(normalizeHeader(keyword)) ? 1 : 0), 0);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  function normalizeMatrix(matrix, sourceName, sheetName) {
    if (!Array.isArray(matrix) || matrix.length < 2) return [];
    const headerRowIndex = detectHeaderRow(matrix);
    const originalHeaders = matrix[headerRowIndex].map((value) => String(value ?? "").trim());
    const headers = originalHeaders.map(normalizeHeader);

    const columns = {
      sequence: findColumn(headers, ["序号", "编号"]),
      department: findColumn(headers, ["一级部门", "所属部门", "部门"]),
      subDepartment: findColumn(headers, ["二级部门", "小组", "团队"]),
      role: findColumn(headers, ["任职岗位", "岗位", "职位"]),
      name: findColumn(headers, ["姓名", "实习生"]),
      school: findColumn(headers, ["学校", "院校"]),
      major: findColumn(headers, ["专业"]),
      education: findColumn(headers, ["学历"]),
      startDate: findColumn(headers, ["入职日期", "入职时间"]),
      mentor: findColumn(headers, ["部门负责人/带教人", "带教人", "负责人", "导师"]),
      urgency: findColumn(headers, ["项目紧急度", "紧急度", "优先级"]),
      notes: findColumn(headers, ["备注"]),
      month: findColumn(headers, ["年月", "月份", "工作月份"]),
    };

    let scheduleColumns = originalHeaders
      .map((header, index) => {
        const normalized = normalizeHeader(header);
        const isSchedule = /(工作安排|工作计划|月度安排|任务安排|工作内容|本月工作)/.test(normalized);
        return isSchedule ? { index, month: parseMonth(header, "") } : null;
      })
      .filter(Boolean);

    if (!scheduleColumns.length) {
      const genericIndex = findColumn(headers, ["安排", "任务", "工作"]);
      if (genericIndex >= 0) {
        scheduleColumns = [{ index: genericIndex, month: parseMonth(sheetName || sourceName, "") }];
      }
    }

    if (columns.name < 0 || !scheduleColumns.length) return [];

    const records = [];
    matrix.slice(headerRowIndex + 1).forEach((row, rowIndex) => {
      const name = String(row[columns.name] ?? "").trim();
      if (!name) return;

      scheduleColumns.forEach((scheduleColumn) => {
        const schedule = String(row[scheduleColumn.index] ?? "").trim();
        if (!schedule) return;
        const rowMonth = columns.month >= 0 ? row[columns.month] : "";
        const month = parseMonth(rowMonth, scheduleColumn.month || parseMonth(sheetName || sourceName));
        const sequence = String(row[columns.sequence] ?? rowIndex + 1).trim();
        records.push({
          id: `${month}-${name}-${sequence}-${scheduleColumn.index}`,
          sequence: Number(sequence) || rowIndex + 1,
          month,
          department: String(row[columns.department] ?? "未归类").trim() || "未归类",
          subDepartment: String(row[columns.subDepartment] ?? "").trim(),
          role: String(row[columns.role] ?? "").trim(),
          name,
          school: String(row[columns.school] ?? "").trim(),
          major: String(row[columns.major] ?? "").trim(),
          education: String(row[columns.education] ?? "").trim(),
          startDate: normalizeDate(row[columns.startDate]),
          mentor: String(row[columns.mentor] ?? "").trim(),
          schedule,
          urgency: urgencyNumber(row[columns.urgency]),
          notes: String(row[columns.notes] ?? "").trim(),
          source: sourceName || "导入数据",
        });
      });
    });

    return records;
  }

  function matrixFromText(text) {
    const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const tabLines = lines.filter((line) => line.includes("\t"));
    if (tabLines.length > 1) return tabLines.map((line) => line.split("\t"));

    const markdownLines = lines.filter((line) => line.includes("|") && !/^\|?\s*:?-+/.test(line));
    if (markdownLines.length > 1) {
      return markdownLines.map((line) => line.replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim()));
    }
    return [];
  }

  function deduplicate(records) {
    const unique = new Map();
    records.forEach((record) => unique.set(record.id, record));
    return [...unique.values()];
  }

  function currentFilters() {
    return {
      year: elements.year.value,
      month: elements.month.value,
      department: elements.department.value,
      urgency: elements.urgency.value,
      search: elements.search.value.trim().toLowerCase(),
    };
  }

  function filteredRecords() {
    const filters = currentFilters();
    return state.records
      .filter((record) => {
        const [recordYear, recordMonth] = String(record.month || "").split("-");
        return (!filters.year || recordYear === filters.year)
          && (!filters.month || recordMonth === filters.month);
      })
      .filter((record) => filters.department === "all" || record.department === filters.department)
      .filter((record) => filters.urgency === "all" || record.urgency >= Number(filters.urgency))
      .filter((record) => {
        if (!filters.search) return true;
        return [record.name, record.role, record.schedule, record.mentor, record.department, record.subDepartment]
          .join(" ")
          .toLowerCase()
          .includes(filters.search);
      })
      .sort((a, b) => a.department.localeCompare(b.department, "zh-CN") || a.sequence - b.sequence);
  }

  function starsMarkup(count) {
    return `<span class="urgency" aria-label="${count} 星">${Array.from({ length: count }, () => '<i data-lucide="star"></i>').join("")}</span>`;
  }

  function renderTable(records) {
    elements.scheduleBody.innerHTML = records.map((record) => `
      <tr>
        <td>
          <span class="person-name"><span class="avatar">${escapeHtml(record.name.slice(-1))}</span>${escapeHtml(record.name)}</span>
          <span class="cell-secondary">${escapeHtml(record.role || "岗位未填写")}</span>
        </td>
        <td><span class="department-tag">${escapeHtml(record.department)}</span><span class="cell-secondary">${escapeHtml(record.subDepartment || "-")}</span></td>
        <td class="task-column">${escapeHtml(record.schedule)}</td>
        <td>${escapeHtml(record.mentor || "-")}</td>
        <td>${escapeHtml(record.startDate || "-")}</td>
        <td>${escapeHtml(record.school || "-")}<span class="cell-secondary">${escapeHtml([record.education, record.major].filter(Boolean).join(" · "))}</span></td>
        <td>${starsMarkup(record.urgency)}</td>
        <td class="${record.notes ? "" : "notes-empty"}">${escapeHtml(record.notes || "-")}</td>
      </tr>`).join("");

    elements.mobileList.innerHTML = records.map((record) => `
      <article class="mobile-card">
        <div class="mobile-card-head">
          <div><span class="person-name"><span class="avatar">${escapeHtml(record.name.slice(-1))}</span>${escapeHtml(record.name)}</span><span class="cell-secondary">${escapeHtml(record.role)}</span></div>
          ${starsMarkup(record.urgency)}
        </div>
        <p class="mobile-task">${escapeHtml(record.schedule)}</p>
        <div class="mobile-meta">
          <span><i data-lucide="building-2"></i>${escapeHtml(record.department)} / ${escapeHtml(record.subDepartment || "-")}</span>
          <span><i data-lucide="user-round-check"></i>${escapeHtml(record.mentor || "-")}</span>
          <span><i data-lucide="calendar-days"></i>${escapeHtml(record.startDate || "-")}</span>
        </div>
      </article>`).join("");
  }

  function renderOverview(records) {
    const departmentCounts = [...records.reduce((map, record) => map.set(record.department, (map.get(record.department) || 0) + 1), new Map()).entries()]
      .sort((a, b) => b[1] - a[1]);
    const maxCount = Math.max(...departmentCounts.map(([, count]) => count), 1);
    elements.departmentBars.innerHTML = departmentCounts.map(([department, count]) => `
      <div class="bar-row">
        <span class="bar-label" title="${escapeHtml(department)}">${escapeHtml(department)}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${Math.max(6, (count / maxCount) * 100)}%"></span></span>
        <span class="bar-value">${count}</span>
      </div>`).join("");

    const urgencyCounts = [5, 4, 3, 2, 1].map((level) => [level, records.filter((record) => record.urgency === level).length]);
    elements.urgencyBreakdown.innerHTML = urgencyCounts.map(([level, count]) => `
      <div class="urgency-row"><span>${starsMarkup(level)}</span><strong>${count}</strong></div>`).join("");
    document.querySelector("#overviewTotal").textContent = `共 ${records.length} 人`;
  }

  function renderMetrics(records) {
    const uniqueInterns = new Set(records.map((record) => record.name));
    document.querySelector("#internCount").textContent = uniqueInterns.size;
    document.querySelector("#departmentCount").textContent = new Set(records.map((record) => record.department)).size;
    document.querySelector("#urgentCount").textContent = records.filter((record) => record.urgency === 5).length;
    document.querySelector("#mentorCount").textContent = new Set(records.map((record) => record.mentor).filter(Boolean)).size;
  }

  function render() {
    const records = filteredRecords();
    const year = elements.year.value;
    const month = elements.month.value;
    const department = elements.department.value;
    document.querySelector("#viewTitle").textContent = year && month
      ? `${year} 年 ${Number(month)} 月工作安排`
      : "工作安排";
    document.querySelector("#resultSummary").textContent = `${department === "all" ? "全部部门" : department} · 共 ${records.length} 条安排`;
    renderMetrics(records);
    renderTable(records);
    renderOverview(records);

    const isEmpty = records.length === 0;
    elements.empty.hidden = !isEmpty;
    elements.scheduleView.hidden = isEmpty || state.view !== "schedule";
    elements.overviewView.hidden = isEmpty || state.view !== "overview";
    if (window.lucide) window.lucide.createIcons();
  }

  function populateFilters(preferredMonth) {
    const availableMonths = [...new Set(state.records.map((record) => record.month).filter(Boolean))].sort().reverse();
    const fallbackMonth = availableMonths[0] || `${DEFAULT_YEAR}-${String(new Date().getMonth() + 1).padStart(2, "0")}`;
    const [preferredYear, preferredMonthNumber] = String(preferredMonth || "").split("-");
    const currentYear = preferredYear || elements.year.value || fallbackMonth.split("-")[0];
    const currentMonth = preferredMonthNumber || elements.month.value || fallbackMonth.split("-")[1];
    const currentDepartment = elements.department.value || "all";
    const years = [...new Set(availableMonths.map((month) => month.split("-")[0]))].sort().reverse();
    if (!years.includes(currentYear)) years.unshift(currentYear);
    elements.year.innerHTML = years.map((year) => `<option value="${year}">${year} 年</option>`).join("");
    elements.year.value = currentYear;
    elements.month.innerHTML = MONTH_LABELS.map((label, index) => {
      const monthNumber = String(index + 1).padStart(2, "0");
      return `<option value="${monthNumber}">${label}月</option>`;
    }).join("");
    elements.month.value = currentMonth;

    const departments = [...new Set(state.records.map((record) => record.department).filter(Boolean))].sort((a, b) => a.localeCompare(b, "zh-CN"));
    elements.department.innerHTML = `<option value="all">全部部门</option>${departments.map((department) => `<option value="${escapeHtml(department)}">${escapeHtml(department)}</option>`).join("")}`;
    elements.department.value = departments.includes(currentDepartment) ? currentDepartment : "all";
  }

  async function saveRecords() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.records));
  }

  function showToast(message, type) {
    elements.toast.textContent = message;
    elements.toast.className = `toast show${type === "error" ? " error" : ""}`;
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => { elements.toast.className = "toast"; }, 2800);
  }

  async function applyImportedRecords(imported, label) {
    if (!imported.length) throw new Error("没有识别到姓名和工作安排字段");
    state.records = state.mergeMode === "append" ? deduplicate([...state.records, ...imported]) : deduplicate(imported);
    await saveRecords();
    const latestMonth = imported.map((record) => record.month).sort().at(-1);
    populateFilters(latestMonth);
    elements.sourceLabel.textContent = label;
    render();
    elements.uploadDialog.close();
    showToast(`已导入 ${imported.length} 条工作安排`);
  }

  async function importFile(file) {
    if (!window.XLSX) throw new Error("Excel 组件加载失败，请检查网络后重试");
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: "array", cellDates: true });
    const records = workbook.SheetNames.flatMap((sheetName) => {
      const matrix = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName], {
        header: 1,
        defval: "",
        raw: false,
        dateNF: "yyyy-mm-dd",
      });
      return normalizeMatrix(matrix, file.name, sheetName);
    });
    await applyImportedRecords(records, file.name);
  }

  function exportRows(records) {
    return records.map((record, index) => ({
      序号: index + 1,
      年月: record.month,
      一级部门: record.department,
      二级部门: record.subDepartment,
      任职岗位: record.role,
      姓名: record.name,
      学校: record.school,
      专业: record.major,
      学历: record.education,
      入职日期: record.startDate,
      "部门负责人/带教人": record.mentor,
      工作安排: record.schedule,
      项目紧急度: `${record.urgency} 星`,
      备注: record.notes,
    }));
  }

  function downloadBlob(content, mimeType, fileName) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = fileName;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function selectedPeriod() {
    const year = elements.year.value;
    const month = elements.month.value;
    return year && month ? `${year}-${month}` : "全部时间";
  }

  function exportMarkdown(records) {
    const rows = exportRows(records);
    const headers = Object.keys(rows[0] || {});
    const clean = (value) => String(value ?? "").replaceAll("|", "\\|").replace(/\r?\n/g, " ");
    const markdown = [
      `# 实习生项目安排（${selectedPeriod()}）`,
      "",
      `筛选部门：${elements.department.value === "all" ? "全部部门" : elements.department.value}`,
      "",
      `| ${headers.join(" | ")} |`,
      `| ${headers.map(() => "---").join(" | ")} |`,
      ...rows.map((row) => `| ${headers.map((header) => clean(row[header])).join(" | ")} |`),
      "",
    ].join("\n");
    downloadBlob(markdown, "text/markdown;charset=utf-8", `实习生项目安排_${selectedPeriod()}.md`);
  }

  function exportExcel(records) {
    if (!window.XLSX) throw new Error("Excel 组件加载失败，请检查网络后重试");
    const rows = exportRows(records);
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet["!cols"] = [6, 10, 14, 16, 18, 10, 22, 18, 9, 12, 16, 42, 12, 20].map((wch) => ({ wch }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "工作安排");
    XLSX.writeFile(workbook, `实习生项目安排_${selectedPeriod()}.xlsx`, { compression: true });
  }

  async function loadInitialData() {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length) {
          state.records = parsed;
          elements.sourceLabel.textContent = "本机数据";
          return;
        }
      } catch {
        localStorage.removeItem(STORAGE_KEY);
      }
    }

    elements.sourceLabel.textContent = "正在读取数据";
    const response = await fetch("data/records.json", { cache: "no-store" });
    const records = await response.json();
    if (!response.ok || !Array.isArray(records)) throw new Error("初始数据读取失败");
    state.records = records;
    elements.sourceLabel.textContent = "公开数据";
  }

  function bindEvents() {
    [elements.year, elements.month, elements.department, elements.urgency].forEach((element) => element.addEventListener("change", render));
    elements.search.addEventListener("input", render);
    document.querySelector("#resetFilters").addEventListener("click", () => {
      elements.department.value = "all";
      elements.urgency.value = "all";
      elements.search.value = "";
      populateFilters([...new Set(state.records.map((record) => record.month).filter(Boolean))].sort().at(-1));
      render();
    });

    document.querySelector("#uploadButton").addEventListener("click", () => elements.uploadDialog.showModal());
    document.querySelectorAll("[data-view]").forEach((button) => button.addEventListener("click", () => {
      state.view = button.dataset.view;
      document.querySelectorAll("[data-view]").forEach((tab) => {
        tab.classList.toggle("active", tab === button);
        tab.setAttribute("aria-selected", String(tab === button));
      });
      render();
    }));

    document.querySelectorAll("[data-merge-mode]").forEach((button) => button.addEventListener("click", () => {
      state.mergeMode = button.dataset.mergeMode;
      document.querySelectorAll("[data-merge-mode]").forEach((item) => item.classList.toggle("active", item === button));
    }));

    elements.fileInput.addEventListener("change", () => {
      state.pendingFile = elements.fileInput.files?.[0] || null;
      elements.fileNameLabel.textContent = state.pendingFile?.name || "选择 Excel 或 CSV 文件";
    });

    const dropZone = document.querySelector("#dropZone");
    ["dragenter", "dragover"].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.add("dragging");
    }));
    ["dragleave", "drop"].forEach((eventName) => dropZone.addEventListener(eventName, (event) => {
      event.preventDefault();
      dropZone.classList.remove("dragging");
    }));
    dropZone.addEventListener("drop", (event) => {
      state.pendingFile = event.dataTransfer.files?.[0] || null;
      elements.fileNameLabel.textContent = state.pendingFile?.name || "选择 Excel 或 CSV 文件";
    });

    elements.confirmImport.addEventListener("click", async () => {
      const originalHtml = elements.confirmImport.innerHTML;
      elements.confirmImport.disabled = true;
      elements.confirmImport.textContent = "正在导入...";
      try {
        if (!state.pendingFile) throw new Error("请先选择文件");
        await importFile(state.pendingFile);
      } catch (error) {
        showToast(error.message || "导入失败", "error");
      } finally {
        elements.confirmImport.disabled = false;
        elements.confirmImport.innerHTML = originalHtml;
        if (window.lucide) window.lucide.createIcons();
      }
    });

    elements.exportButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const willOpen = elements.exportMenu.hidden;
      elements.exportMenu.hidden = !willOpen;
      elements.exportButton.setAttribute("aria-expanded", String(willOpen));
    });
    document.addEventListener("click", () => {
      elements.exportMenu.hidden = true;
      elements.exportButton.setAttribute("aria-expanded", "false");
    });
    elements.exportMenu.addEventListener("click", (event) => event.stopPropagation());
    document.querySelectorAll("[data-export]").forEach((button) => button.addEventListener("click", () => {
      const records = filteredRecords();
      if (!records.length) {
        showToast("当前筛选没有可下载的数据", "error");
        return;
      }
      try {
        if (button.dataset.export === "xlsx") exportExcel(records);
        else exportMarkdown(records);
        showToast(`已生成 ${records.length} 条筛选结果`);
      } catch (error) {
        showToast(error.message || "下载失败", "error");
      }
      elements.exportMenu.hidden = true;
    }));
  }

  async function init() {
    bindEvents();
    if (window.lucide) window.lucide.createIcons();
    try {
      await loadInitialData();
      populateFilters();
      render();
    } catch (error) {
      elements.sourceLabel.textContent = "数据读取失败";
      populateFilters();
      render();
      showToast(error.message || "初始化失败", "error");
    }
  }

  init();
})();
