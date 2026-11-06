self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

// MVP intentionally does not cache timetable data or application files.
// Every launch continues to load the current Google Sheets data.
