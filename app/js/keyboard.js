/*
 * Copyright (c) 2026 Muse Gadget TV contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Key planning for remote controls AND hardware keyboards.
 *
 * A Bluetooth (or USB) keyboard is paired with the TV itself, not with
 * this app — Samsung's support documentation puts pairing under
 * Settings → General → External Device Manager → Input Device Manager
 * (on 2017+ models, Keyboard Manager) → Add Bluetooth Keyboard — and once
 * paired, the TV delivers its keys to the app as ordinary DOM key events,
 * the same events the remote produces:
 *
 *   remote OK        → key 'Enter', keyCode 13 (same as a keyboard Enter)
 *   remote Return    → keyCode 10009 (key often 'XF86Back' or unset)
 *   remote Back      → keyCode 461
 *   keyboard Escape  → key 'Escape', keyCode 27 — Samsung documents ESC on
 *                      a paired keyboard as "returns to the previous
 *                      screen", so it plans exactly like Return.
 *   keyboard arrows  → 'ArrowUp/Down/Left/Right', as the remote's D-pad.
 *
 * planKey(event, ctx) is a pure function from one key event plus the UI
 * context to one action; app.js executes the action. Actions:
 *
 *   'dismiss'      a card is showing: any key closes it.
 *   'nav'          move spatial focus (direction in the result).
 *   'focus-next' / 'focus-prev'   Tab / Shift+Tab through the controls.
 *   'activate'     Enter (or Space) on the spatially focused button.
 *   'edit'         Enter on a spatially focused text field that does not
 *                  have DOM focus (e.g. after 'exit-editing'): focus it.
 *   'submit'       Enter inside a text field: run the field's action.
 *   'exit-editing' Escape/Return inside a text field: leave the field
 *                  (the TV's on-screen IME also closes) but stay on the
 *                  screen; the next Escape/Return goes back.
 *   'back'         Escape/Return outside a field: go back a screen.
 *   'passthrough'  the field and the platform IME own this key: printable
 *                  characters, Backspace/Delete, caret keys. app.js must
 *                  NOT preventDefault — the browser inserts the text.
 *   'ignore'       swallow the key (preventDefault, no action), for keys
 *                  that would otherwise scroll or beep meaninglessly.
 *
 * The split is what makes a hardware keyboard safe here: while a field
 * has DOM focus, every editing key passes through untouched, so text
 * lands in the field exactly once — app.js never synthesises characters.
 * And whenever app.js does act (activate/submit/nav/back), it calls
 * preventDefault, which also suppresses the browser's own Enter
 * activation of a DOM-focused button, so nothing fires twice.
 *
 * Context (ctx):
 *   cardVisible  — the display-card overlay is up.
 *   editing      — DOM focus is inside an input/textarea.
 *   multiline    — that field is a textarea (all arrows are caret keys).
 *   focusedButton— the app's spatial focus is on a button.
 *   focusedField — the app's spatial focus is on a text field.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};

  // Remote key codes with no reliable KeyboardEvent.key on Tizen:
  // 10009 = Return, 461 = Back (Samsung TV key tables).
  var RETURN_KEYCODES = { 10009: true, 461: true };
  var BACK_KEYS = { XF86Back: true, GoBack: true, BrowserBack: true };

  function isBackEvent(ev) {
    return !!(
      ev.key === 'Escape' ||
      BACK_KEYS[ev.key] ||
      RETURN_KEYCODES[ev.keyCode]
    );
  }

  function isPrintable(ev) {
    return typeof ev.key === 'string' && ev.key.length === 1;
  }

  function planKey(ev, ctx) {
    ctx = ctx || {};
    if (ctx.cardVisible) return { action: 'dismiss' };

    var key = ev.key;

    if (key === 'Tab') {
      return { action: ev.shiftKey ? 'focus-prev' : 'focus-next' };
    }

    if (isBackEvent(ev)) {
      return { action: ctx.editing ? 'exit-editing' : 'back' };
    }

    if (key === 'Enter') {
      if (ctx.editing) return { action: 'submit' };
      if (ctx.focusedButton) return { action: 'activate' };
      if (ctx.focusedField) return { action: 'edit' };
      return { action: 'ignore' };
    }

    if (key && key.indexOf('Arrow') === 0) {
      var direction = key.slice(5).toLowerCase(); // up/down/left/right
      if (ctx.editing) {
        // Inside a field the arrows belong to the caret: both axes in a
        // textarea; left/right in a single-line input. Up/down in a
        // single-line input have no caret meaning, so they still move
        // spatial focus, like the remote does.
        if (ctx.multiline) return { action: 'passthrough' };
        if (direction === 'left' || direction === 'right') {
          return { action: 'passthrough' };
        }
      }
      return { action: 'nav', direction: direction };
    }

    if (ctx.editing) {
      // Printable characters, Backspace, Delete, Home/End, PageUp/Down in
      // a textarea: the field (and the IME) handles them, exactly once.
      return { action: 'passthrough' };
    }

    if (key === ' ' && ctx.focusedButton) {
      // A keyboard's Space activates the focused button, like a click;
      // without this the page would scroll instead.
      return { action: 'activate' };
    }
    if (isPrintable(ev) || key === 'Backspace' || key === ' ') {
      return { action: 'ignore' };
    }
    return { action: 'passthrough' };
  }

  MG.keyboard = {
    planKey: planKey,
    isBackEvent: isBackEvent,
    RETURN_KEYCODES: RETURN_KEYCODES,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.keyboard;
})(typeof globalThis !== 'undefined' ? globalThis : this);
