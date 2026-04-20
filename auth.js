'use strict';
/* ================================================================
   LP Tracker Pro — auth.js
   Wrapper de Supabase Auth con mensajes de error en español.
================================================================ */

const Auth = {

  async signUp(email, password) {
    const { data, error } = await sb.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin }
    });
    if (error) throw new Error(_translateError(error.message));
    return data;
  },

  async signIn(email, password) {
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw new Error(_translateError(error.message));
    return data;
  },

  async signOut() {
    const { error } = await sb.auth.signOut();
    if (error) throw new Error(error.message);
  },

  async getSession() {
    const { data: { session }, error } = await sb.auth.getSession();
    if (error) throw new Error(error.message);
    return session;
  },

  /** Llama callback(event, session) en cada cambio de estado de auth */
  onAuthStateChange(callback) {
    const { data: { subscription } } = sb.auth.onAuthStateChange(callback);
    return subscription;
  }
};

function _translateError(msg = '') {
  if (msg.includes('Invalid login credentials'))   return 'Email o contraseña incorrectos.';
  if (msg.includes('Email not confirmed'))          return 'Debes confirmar tu email antes de iniciar sesión.';
  if (msg.includes('User already registered'))      return 'Este email ya tiene una cuenta. Inicia sesión.';
  if (msg.includes('Password should be'))           return 'La contraseña debe tener al menos 6 caracteres.';
  if (msg.includes('rate limit') || msg.includes('too many')) return 'Demasiados intentos. Espera un momento.';
  if (msg.includes('Unable to validate') || msg.includes('network')) return 'Error de conexión. Verifica tu internet.';
  if (msg.includes('Signup is disabled'))           return 'El registro está deshabilitado en este momento.';
  return msg || 'Error desconocido. Intenta de nuevo.';
}
