'use strict';
/* ================================================================
   LP Tracker Pro — config.js
   Claves públicas de servicios externos.
================================================================ */

// API key de The Graph (thegraph.com/studio → API Keys).
// Trae el depósito y la fecha de entrada de cada posición.
// Restríngela a tu dominio en Studio, porque queda visible en el navegador.
const GRAPH_API_KEY = '5f7211e61ed53b024eeb13c2e5170dd3';

if (typeof module !== 'undefined') module.exports = { GRAPH_API_KEY };
