const CACHE_NAME = "autoneer-migrator-shell-v1";
const ASSETS = [
	"/setup",
	"/public/css/styles.css",
	"/public/js/app.js",
	"/public/manifest.webmanifest"
];

self.addEventListener("install", (event) => {
	event.waitUntil(
		caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
	);
});

self.addEventListener("fetch", (event) => {
	if (event.request.method !== "GET") return;
	event.respondWith(
		caches.match(event.request).then((cached) => cached || fetch(event.request))
	);
});
