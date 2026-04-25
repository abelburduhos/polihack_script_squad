// Frontend-only configuration. Simulation parameters live in server/config.js.
const CONFIG = {
  map: {
    center: [46.0, 24.5],
    zoom: 7,
    tile: {
      url: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
      attribution:
        "&copy; <a href='https://www.openstreetmap.org/copyright'>OpenStreetMap</a> &copy; <a href='https://carto.com/attributions'>CARTO</a>",
      maxZoom: 19,
      subdomains: "abcd",
    },
  },
  home: {
    autoRotateSpeed: 0.0025,
    scrollZoom: 0.9,
    scrollTilt: 0.35,
  },
};
