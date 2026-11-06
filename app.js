const CONFIG = {
  spreadsheetId: "1DR2RL5bXHbElkW3DfAdExU9wEGMenpS2w62MQHB3p1s",
  schools: [{ id: "ЦО", name: "ЦО" }],
  days: [
    { key: "понедельник", short: "Пн", title: "Понедельник", jsDay: 1 },
    { key: "вторник", short: "Вт", title: "Вторник", jsDay: 2 },
    { key: "среда", short: "Ср", title: "Среда", jsDay: 3 },
    { key: "четверг", short: "Чт", title: "Четверг", jsDay: 4 },
    { key: "пятница", short: "Пт", title: "Пятница", jsDay: 5 },
  ],
  longBreakMinutes: 15,
  notifyBeforeMinutes: 15,
};

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./service-worker.js").catch((error) => {
      console.warn("Не удалось зарегистрировать service worker", error);
    });
  });
}

const PROFILE_STORAGE_KEY = "school-schedule-profile-v1";
const NATIVE_NOTIFICATION_ID = 11001;

const state = {
  dataByDay: new Map(),
  profile: readProfile(),
  selectedDayKey: getInitialDayKey(),
  settingsMode: false,
  notificationTimer: null,
  gvizRequestId: 0,
};

const elements = {
  loadingScreen: document.querySelector("#loading-screen"),
  errorScreen: document.querySelector("#error-screen"),
  errorMessage: document.querySelector("#error-message"),
  retryButton: document.querySelector("#retry-button"),
  setupScreen: document.querySelector("#setup-screen"),
  setupTitle: document.querySelector("#setup-title"),
  profileForm: document.querySelector("#profile-form"),
  schoolSelect: document.querySelector("#school-select"),
  classSelect: document.querySelector("#class-select"),
  teacherSelect: document.querySelector("#teacher-select"),
  beneficiaryCheckbox: document.querySelector("#beneficiary-checkbox"),
  studentFields: document.querySelector("#student-fields"),
  teacherFields: document.querySelector("#teacher-fields"),
  formError: document.querySelector("#form-error"),
  cancelSettingsButton: document.querySelector("#cancel-settings-button"),
  mainScreen: document.querySelector("#main-screen"),
  settingsButton: document.querySelector("#settings-button"),
  profilePrimary: document.querySelector("#profile-primary"),
  profileSecondary: document.querySelector("#profile-secondary"),
  dayTabs: document.querySelector("#day-tabs"),
  scheduleCaption: document.querySelector("#schedule-caption"),
  scheduleTitle: document.querySelector("#schedule-title"),
  lessonCount: document.querySelector("#lesson-count"),
  scheduleList: document.querySelector("#schedule-list"),
  notificationCard: document.querySelector("#notification-card"),
  notificationTitle: document.querySelector("#notification-title"),
  notificationText: document.querySelector("#notification-text"),
  notificationButton: document.querySelector("#notification-button"),
  toast: document.querySelector("#toast"),
};

elements.retryButton.addEventListener("click", bootstrap);
elements.profileForm.addEventListener("submit", saveProfileFromForm);
elements.settingsButton.addEventListener("click", () => openSetup(true));
elements.cancelSettingsButton.addEventListener("click", renderMainScreen);
elements.notificationButton.addEventListener("click", requestNotificationPermission);

for (const input of document.querySelectorAll('input[name="role"]')) {
  input.addEventListener("change", updateRoleFields);
}

bootstrap();

async function bootstrap() {
  clearNotificationTimer();
  showOnly(elements.loadingScreen);

  try {
    const school = CONFIG.schools[0];
    const sheets = await Promise.all(
      CONFIG.days.map(async (day) => {
        const sheetName = `${school.id}_${day.key}`;
        const table = await loadGoogleSheet(sheetName);
        return [day.key, normalizeScheduleTable(table, sheetName)];
      }),
    );

    state.dataByDay = new Map(sheets);
    populateSchoolOptions();
    populateProfileOptions();

    if (isProfileValid(state.profile)) {
      renderMainScreen();
    } else {
      state.profile = null;
      openSetup(false);
    }
  } catch (error) {
    console.error(error);
    elements.errorMessage.textContent = error instanceof Error
      ? error.message
      : "Неизвестная ошибка загрузки.";
    showOnly(elements.errorScreen);
  }
}

function loadGoogleSheet(sheetName) {
  return new Promise((resolve, reject) => {
    const requestId = ++state.gvizRequestId;
    const callbackName = `__scheduleGvizCallback${requestId}`;
    const script = document.createElement("script");
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Лист «${sheetName}» не ответил вовремя.`));
    }, 15000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      script.remove();
      delete window[callbackName];
    };

    window[callbackName] = (response) => {
      cleanup();

      if (!response || response.status !== "ok" || !response.table) {
        const message = response?.errors?.[0]?.message || "Google Таблицы вернули ошибку.";
        reject(new Error(`Не удалось прочитать лист «${sheetName}»: ${message}`));
        return;
      }

      const headers = response.table.cols.map((column) => String(column.label || column.id || "").trim());
      const rows = response.table.rows.map((row) =>
        headers.map((_, index) => {
          const cell = row.c?.[index];
          if (!cell) return "";
          return String(cell.f ?? cell.v ?? "").trim();
        }),
      );

      resolve({ headers, rows });
    };

    const query = new URLSearchParams({
      sheet: sheetName,
      tqx: `out:json;responseHandler:${callbackName}`,
    });

    script.src = `https://docs.google.com/spreadsheets/d/${CONFIG.spreadsheetId}/gviz/tq?${query}`;
    script.async = true;
    script.onerror = () => {
      cleanup();
      reject(new Error(`Не удалось подключиться к листу «${sheetName}».`));
    };
    document.head.append(script);
  });
}

function normalizeScheduleTable(table, sheetName) {
  let headers = table.headers;
  let rows = table.rows;

  if (headers[0] !== "Урок" && rows[0]?.[0] === "Урок") {
    headers = rows[0].map((value) => String(value).trim());
    rows = rows.slice(1);
  }

  if (headers[0] !== "Урок") {
    throw new Error(`В листе «${sheetName}» первая колонка должна называться «Урок».`);
  }

  const classes = headers.slice(1).filter(Boolean);
  if (!classes.length) {
    throw new Error(`В листе «${sheetName}» не найдены классы.`);
  }

  const lessons = rows
    .filter((row) => row.some(Boolean))
    .map((row, rowIndex) => {
      const lesson = parseLessonLabel(row[0], sheetName, rowIndex + 2);
      const cells = {};

      for (let columnIndex = 0; columnIndex < classes.length; columnIndex += 1) {
        const className = classes[columnIndex];
        cells[className] = parseScheduleCell(
          row[columnIndex + 1],
          sheetName,
          rowIndex + 2,
          className,
        );
      }

      return { ...lesson, cells };
    });

  return { sheetName, classes, lessons };
}

function parseLessonLabel(value, sheetName, rowNumber) {
  const match = String(value).match(/^\s*(\d+)\s*,\s*(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})\s*$/);
  if (!match) {
    throw new Error(`Ошибка в ${sheetName}, строка ${rowNumber}: неверный формат урока.`);
  }

  return {
    number: Number(match[1]),
    start: normalizeTime(match[2]),
    end: normalizeTime(match[3]),
  };
}

function parseScheduleCell(value, sheetName, rowNumber, className) {
  const text = String(value || "").trim();
  if (!text) return null;

  const parts = text.split(",").map((part) => part.trim());
  if (parts.length < 3 || parts.some((part) => !part)) {
    throw new Error(
      `Ошибка в ${sheetName}, строка ${rowNumber}, класс ${className}: ` +
      "ожидалось «предмет, кабинет, ФИО учителя».",
    );
  }

  return {
    subject: parts[0],
    room: parts[1],
    teacher: parts.slice(2).join(", "),
  };
}

function normalizeTime(value) {
  const [hours, minutes] = value.split(":").map(Number);
  if (hours > 23 || minutes > 59) {
    throw new Error(`Некорректное время «${value}».`);
  }
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function populateSchoolOptions() {
  elements.schoolSelect.replaceChildren();
  for (const school of CONFIG.schools) {
    elements.schoolSelect.add(new Option(school.name, school.id));
  }
}

function populateProfileOptions() {
  const classes = new Set();
  const teachers = new Set();

  for (const dayData of state.dataByDay.values()) {
    dayData.classes.forEach((className) => classes.add(className));
    for (const lesson of dayData.lessons) {
      Object.values(lesson.cells).forEach((cell) => {
        if (cell?.teacher) teachers.add(cell.teacher);
      });
    }
  }

  replaceSelectOptions(elements.classSelect, [...classes].sort(naturalCompare));
  replaceSelectOptions(elements.teacherSelect, [...teachers].sort(naturalCompare));
}

function replaceSelectOptions(select, values) {
  const previous = select.value;
  select.replaceChildren();
  for (const value of values) select.add(new Option(value, value));
  if (values.includes(previous)) select.value = previous;
}

function openSetup(settingsMode) {
  state.settingsMode = settingsMode;
  elements.setupTitle.textContent = settingsMode ? "Настройки" : "Настройте приложение";
  elements.cancelSettingsButton.hidden = !settingsMode;
  elements.formError.hidden = true;

  if (state.profile) {
    elements.schoolSelect.value = state.profile.schoolId;
    const roleInput = document.querySelector(`input[name="role"][value="${state.profile.role}"]`);
    if (roleInput) roleInput.checked = true;
    if (state.profile.role === "student") {
      elements.classSelect.value = state.profile.className;
      elements.beneficiaryCheckbox.checked = Boolean(state.profile.isBeneficiary);
    } else {
      elements.teacherSelect.value = state.profile.teacherName;
    }
  }

  updateRoleFields();
  showOnly(elements.setupScreen);
}

function updateRoleFields() {
  const role = getSelectedRole();
  elements.studentFields.hidden = role !== "student";
  elements.teacherFields.hidden = role !== "teacher";
}

function saveProfileFromForm(event) {
  event.preventDefault();
  const role = getSelectedRole();
  const profile = {
    schoolId: elements.schoolSelect.value,
    role,
    ...(role === "student"
      ? {
          className: elements.classSelect.value,
          isBeneficiary: elements.beneficiaryCheckbox.checked,
        }
      : { teacherName: elements.teacherSelect.value }),
  };

  if (!isProfileValid(profile)) {
    elements.formError.textContent = "Проверьте выбранные параметры.";
    elements.formError.hidden = false;
    return;
  }

  state.profile = profile;
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(profile));
  renderMainScreen();
  showToast("Настройки сохранены");
}

function renderMainScreen() {
  if (!state.profile) {
    openSetup(false);
    return;
  }

  const profile = state.profile;
  if (profile.role === "student") {
    elements.profilePrimary.textContent = `${profile.className} класс`;
    elements.profileSecondary.textContent = profile.isBeneficiary ? "Ученик · льготник" : "Ученик";
  } else {
    elements.profilePrimary.textContent = profile.teacherName;
    elements.profileSecondary.textContent = "Учитель";
  }

  renderDayTabs();
  renderSchedule();
  renderNotificationCard();
  showOnly(elements.mainScreen);
}

function renderDayTabs() {
  elements.dayTabs.replaceChildren();

  for (const day of CONFIG.days) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "day-tab";
    button.textContent = day.short;
    button.dataset.day = day.key;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(day.key === state.selectedDayKey));
    button.addEventListener("click", () => {
      state.selectedDayKey = day.key;
      renderDayTabs();
      renderSchedule();
    });
    elements.dayTabs.append(button);
  }
}

function renderSchedule() {
  const day = CONFIG.days.find((item) => item.key === state.selectedDayKey);
  const dayData = state.dataByDay.get(state.selectedDayKey);
  const profile = state.profile;
  const breaks = getLongBreaks(dayData.lessons);
  const targetBreakIndex = profile.role === "student" ? (profile.isBeneficiary ? 0 : 1) : -1;
  let visibleLessonCount = 0;

  elements.scheduleCaption.textContent = profile.role === "student"
    ? `Класс ${profile.className}`
    : "Персональное расписание";
  elements.scheduleTitle.textContent = day.title;
  elements.scheduleList.replaceChildren();

  dayData.lessons.forEach((lesson, lessonIndex) => {
    const entries = getLessonEntries(lesson, profile);
    if (entries.length) visibleLessonCount += 1;
    elements.scheduleList.append(createLessonCard(lesson, entries));

    const longBreakIndex = breaks.findIndex((item) => item.afterLessonIndex === lessonIndex);
    if (longBreakIndex >= 0) {
      elements.scheduleList.append(
        createBreakCard(breaks[longBreakIndex], longBreakIndex, longBreakIndex === targetBreakIndex),
      );
    }
  });

  elements.lessonCount.textContent = `${visibleLessonCount} ${pluralizeLessons(visibleLessonCount)}`;

  if (!dayData.lessons.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "На этот день расписание не заполнено.";
    elements.scheduleList.append(empty);
  }
}

function getLessonEntries(lesson, profile) {
  if (profile.role === "student") {
    const cell = lesson.cells[profile.className];
    return cell ? [{ ...cell, className: profile.className }] : [];
  }

  return Object.entries(lesson.cells)
    .filter(([, cell]) => cell?.teacher === profile.teacherName)
    .map(([className, cell]) => ({ ...cell, className }));
}

function createLessonCard(lesson, entries) {
  const card = document.createElement("article");
  card.className = "lesson-card";

  const time = document.createElement("div");
  time.className = "lesson-time";

  const start = document.createElement("strong");
  start.textContent = lesson.start;
  const end = document.createElement("span");
  end.textContent = `до ${lesson.end}`;
  const number = document.createElement("span");
  number.textContent = `${lesson.number} урок`;
  time.append(start, end, number);

  const content = document.createElement("div");
  content.className = "lesson-content";

  if (!entries.length) {
    const empty = document.createElement("span");
    empty.className = "lesson-empty";
    empty.textContent = "Нет урока";
    content.append(empty);
  } else {
    for (const entry of entries) {
      const block = document.createElement("div");
      block.className = "lesson-entry";

      const subject = document.createElement("strong");
      subject.textContent = entry.subject;

      const meta = document.createElement("div");
      meta.className = "lesson-meta";
      const room = document.createElement("span");
      room.textContent = `Кабинет: ${entry.room}`;
      const detail = document.createElement("span");
      detail.textContent = state.profile.role === "teacher"
        ? `Класс: ${entry.className}`
        : entry.teacher;
      meta.append(room, detail);
      block.append(subject, meta);
      content.append(block);
    }
  }

  card.append(time, content);
  return card;
}

function createBreakCard(longBreak, index, isTarget) {
  const card = document.createElement("div");
  card.className = `break-card${isTarget ? " break-card--target" : ""}`;

  const dot = document.createElement("span");
  dot.className = "break-dot";
  dot.setAttribute("aria-hidden", "true");

  const text = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = index === 0
    ? "Первая большая перемена"
    : index === 1
      ? "Вторая большая перемена"
      : "Большая перемена";
  const detail = document.createElement("span");
  detail.textContent = `${longBreak.start}–${longBreak.end} · ${longBreak.duration} минут${isTarget ? " · ваша" : ""}`;
  text.append(title, detail);
  card.append(dot, text);
  return card;
}

function getLongBreaks(lessons) {
  const result = [];
  for (let index = 0; index < lessons.length - 1; index += 1) {
    const current = lessons[index];
    const next = lessons[index + 1];
    const duration = timeToMinutes(next.start) - timeToMinutes(current.end);
    if (duration >= CONFIG.longBreakMinutes) {
      result.push({
        afterLessonIndex: index,
        start: current.end,
        end: next.start,
        duration,
      });
    }
  }
  return result;
}

function renderNotificationCard() {
  clearNotificationTimer();
  const profile = state.profile;

  if (profile.role !== "student") {
    elements.notificationCard.hidden = true;
    void cancelNativeNotification();
    return;
  }

  elements.notificationCard.hidden = false;
  elements.notificationButton.hidden = true;

  const todayKey = CONFIG.days.find((day) => day.jsDay === new Date().getDay())?.key;
  const todayData = todayKey ? state.dataByDay.get(todayKey) : null;
  const breaks = todayData ? getLongBreaks(todayData.lessons) : [];
  const targetIndex = profile.isBeneficiary ? 0 : 1;
  const targetBreak = breaks[targetIndex];
  const groupName = profile.isBeneficiary ? "льготников" : "остальных учеников";

  elements.notificationTitle.textContent = `Большая перемена для ${groupName}`;

  if (!todayKey) {
    elements.notificationText.textContent = "Сегодня выходной. Уведомление не планируется.";
    void cancelNativeNotification();
    return;
  }

  if (!targetBreak) {
    elements.notificationText.textContent = "Сегодня подходящая большая перемена не найдена.";
    void cancelNativeNotification();
    return;
  }

  const notifyAt = minutesToTime(timeToMinutes(targetBreak.start) - CONFIG.notifyBeforeMinutes);
  const baseText = `Перемена начнётся в ${targetBreak.start}. Уведомление — в ${notifyAt}.`;

  if (getNativeLocalNotifications()) {
    void scheduleNativeNotification(targetBreak, notifyAt, baseText);
    return;
  }

  if (!("Notification" in window)) {
    elements.notificationText.textContent = `${baseText} Этот браузер не поддерживает системные уведомления.`;
    return;
  }

  if (Notification.permission === "denied") {
    elements.notificationText.textContent = `${baseText} Уведомления запрещены в настройках браузера.`;
    return;
  }

  if (Notification.permission !== "granted") {
    elements.notificationText.textContent = `${baseText} Разрешите уведомления, чтобы проверить их в браузере.`;
    elements.notificationButton.hidden = false;
    return;
  }

  const targetDate = dateAtTime(new Date(), notifyAt);
  const delay = targetDate.getTime() - Date.now();
  if (delay <= 0) {
    elements.notificationText.textContent = `${baseText} Сегодня это время уже прошло.`;
    return;
  }

  elements.notificationText.textContent = `${baseText} В браузере страница должна оставаться открытой.`;
  state.notificationTimer = window.setTimeout(() => {
    new Notification("Скоро большая перемена", {
      body: `Большая перемена начнётся в ${targetBreak.start}.`,
      tag: "school-long-break",
    });
  }, delay);
}

async function requestNotificationPermission() {
  try {
    const nativeNotifications = getNativeLocalNotifications();
    if (nativeNotifications) {
      const permission = await nativeNotifications.requestPermissions();
      renderNotificationCard();
      showToast(permission.display === "granted" ? "Уведомления включены" : "Уведомления не включены");
      return;
    }

    const permission = await Notification.requestPermission();
    renderNotificationCard();
    showToast(permission === "granted" ? "Уведомления включены" : "Уведомления не включены");
  } catch (error) {
    console.error(error);
    showToast("Не удалось запросить разрешение");
  }
}

function getNativeLocalNotifications() {
  const capacitor = window.Capacitor;
  if (!capacitor?.isNativePlatform?.() || !capacitor.isPluginAvailable?.("LocalNotifications")) {
    return null;
  }
  return capacitor.Plugins?.LocalNotifications || null;
}

async function scheduleNativeNotification(targetBreak, notifyAt, baseText) {
  const nativeNotifications = getNativeLocalNotifications();
  if (!nativeNotifications) return;

  const targetDate = dateAtTime(new Date(), notifyAt);
  const delay = targetDate.getTime() - Date.now();
  await cancelNativeNotification();

  if (delay <= 0) {
    elements.notificationText.textContent = `${baseText} Сегодня это время уже прошло.`;
    return;
  }

  try {
    const permission = await nativeNotifications.checkPermissions();
    if (permission.display !== "granted") {
      elements.notificationText.textContent = `${baseText} Разрешите уведомления на телефоне.`;
      elements.notificationButton.hidden = false;
      return;
    }

    const result = await nativeNotifications.schedule({
      notifications: [{
        id: NATIVE_NOTIFICATION_ID,
        title: "Скоро большая перемена",
        body: `Большая перемена начнётся в ${targetBreak.start}.`,
        schedule: { at: targetDate, allowWhileIdle: true },
        foreground: true,
        isExactNotification: true,
        isExactMandatory: false,
      }],
    });

    elements.notificationText.textContent = result.warning
      ? `${baseText} Android может показать уведомление с небольшой задержкой.`
      : `${baseText} Уведомление запланировано на телефоне.`;
  } catch (error) {
    console.error(error);
    elements.notificationText.textContent = `${baseText} Не удалось запланировать уведомление.`;
    elements.notificationButton.hidden = false;
  }
}

async function cancelNativeNotification() {
  const nativeNotifications = getNativeLocalNotifications();
  if (!nativeNotifications) return;

  try {
    await nativeNotifications.cancel({ notifications: [{ id: NATIVE_NOTIFICATION_ID }] });
  } catch (error) {
    console.warn("Не удалось отменить старое уведомление", error);
  }
}

function clearNotificationTimer() {
  if (state.notificationTimer !== null) {
    window.clearTimeout(state.notificationTimer);
    state.notificationTimer = null;
  }
}

function isProfileValid(profile) {
  if (!profile || !CONFIG.schools.some((school) => school.id === profile.schoolId)) return false;

  if (profile.role === "student") {
    return getAllClasses().includes(profile.className);
  }

  if (profile.role === "teacher") {
    return getAllTeachers().includes(profile.teacherName);
  }

  return false;
}

function getAllClasses() {
  return [...new Set([...state.dataByDay.values()].flatMap((day) => day.classes))];
}

function getAllTeachers() {
  const teachers = new Set();
  for (const day of state.dataByDay.values()) {
    for (const lesson of day.lessons) {
      Object.values(lesson.cells).forEach((cell) => {
        if (cell?.teacher) teachers.add(cell.teacher);
      });
    }
  }
  return [...teachers];
}

function readProfile() {
  try {
    const value = localStorage.getItem(PROFILE_STORAGE_KEY);
    return value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
}

function getSelectedRole() {
  return document.querySelector('input[name="role"]:checked')?.value || "student";
}

function getInitialDayKey() {
  const today = new Date().getDay();
  return CONFIG.days.find((day) => day.jsDay === today)?.key || CONFIG.days[0].key;
}

function timeToMinutes(time) {
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function minutesToTime(totalMinutes) {
  const normalized = ((totalMinutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(normalized / 60)).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

function dateAtTime(date, time) {
  const [hours, minutes] = time.split(":").map(Number);
  const result = new Date(date);
  result.setHours(hours, minutes, 0, 0);
  return result;
}

function naturalCompare(left, right) {
  return left.localeCompare(right, "ru", { numeric: true, sensitivity: "base" });
}

function pluralizeLessons(count) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return "урок";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "урока";
  return "уроков";
}

function showOnly(activeScreen) {
  [elements.loadingScreen, elements.errorScreen, elements.setupScreen, elements.mainScreen]
    .forEach((screen) => { screen.hidden = screen !== activeScreen; });
}

let toastTimer;
function showToast(message) {
  window.clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  toastTimer = window.setTimeout(() => { elements.toast.hidden = true; }, 2200);
}
