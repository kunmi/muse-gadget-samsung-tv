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
 * The TV command set, in the shape of the Muse Gadget SDK's executor.py:
 * COMMAND_SPECS is advertised in link.register's commands_v2, and
 * createExecutor returns the run(command, params, timeoutMs) the link
 * session dispatches link.invoke to. Results are {"ok": true, "payload":…}
 * or {"ok": false, "error": "…"}; unknown commands and bad parameters get a
 * proper error result, never a crash.
 *
 * The Linux SDK's system.run / file.read / file.write are deliberately NOT
 * ported: a TV web app has no shell and no general file system, and giving a
 * cloud session shell access to a television is neither possible nor wise.
 * See PROTOCOL.md.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var tv = MG.tv;

  var COMMAND_SPECS = {
    'display.text': {
      description: 'Show a message card on the TV screen. Use for short messages the household should see.',
      required: {
        text: { type: 'string', description: 'The message to show on the TV.' },
      },
      optional: {
        title: { type: 'string', description: 'Optional heading above the message.' },
      },
    },
    'display.image': {
      description: 'Show an image on the TV screen, loaded from a URL.',
      required: {
        url: { type: 'string', description: 'HTTP(S) URL of the image to show.' },
      },
      optional: {
        caption: { type: 'string', description: 'Optional caption under the image.' },
      },
    },
    'display.briefing': {
      description: 'Show a briefing card on the TV: a title and a list of short lines.',
      required: {
        title: { type: 'string', description: 'The briefing heading.' },
        lines: { type: 'array', description: 'Array of strings, one per line of the briefing.' },
      },
      optional: {},
    },
    'tv.volume.get': {
      description: 'Read the TV volume (0-100) and mute state.',
      required: {},
      optional: {},
    },
    'tv.volume.set': {
      description: 'Set the TV volume (0-100).',
      required: {
        level: { type: 'integer', description: 'Volume level, 0 to 100.' },
      },
      optional: {},
    },
    'tv.volume.up': {
      description: 'Turn the TV volume up.',
      required: {},
      optional: {
        step: { type: 'integer', description: 'How much to raise it by. Default: one step.' },
      },
    },
    'tv.volume.down': {
      description: 'Turn the TV volume down.',
      required: {},
      optional: {
        step: { type: 'integer', description: 'How much to lower it by. Default: one step.' },
      },
    },
    'tv.mute': {
      description: 'Mute or unmute the TV. Without "muted", toggles the current state.',
      required: {},
      optional: {
        muted: { type: 'boolean', description: 'True to mute, false to unmute. Omit to toggle.' },
      },
    },
    'tv.launch_app': {
      description: 'Open an installed TV app by its Tizen application id (for example "org.tizen.netflix-app").',
      required: {
        app_id: { type: 'string', description: 'The Tizen application id to launch.' },
      },
      optional: {},
    },
    'device.health': {
      description: 'TV status: model, firmware, Tizen version, app uptime, network, storage when available.',
      required: {},
      optional: {},
    },
  };

  function ok(payload) {
    return { ok: true, payload: payload };
  }

  function error(message) {
    return { ok: false, error: String(message) };
  }

  function requireString(params, name) {
    var value = params[name];
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('missing or invalid parameter: ' + name + ' (string required)');
    }
    return value;
  }

  function optionalString(params, name) {
    var value = params[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') {
      throw new Error('invalid parameter: ' + name + ' (string required)');
    }
    return value;
  }

  function optionalInt(params, name) {
    var value = params[name];
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !isFinite(value)) {
      throw new Error('invalid parameter: ' + name + ' (integer required)');
    }
    return Math.round(value);
  }

  // ui: {showText({title, text}), showImage({url, caption}),
  //      showBriefing({title, lines})} — supplied by app.js.
  // deps: {startedAt} for uptime.
  function createExecutor(ui, deps) {
    deps = deps || {};
    var startedAt = deps.startedAt || Date.now();

    function volumeState() {
      var state = { volume: tv.volume.get() };
      try {
        state.muted = tv.volume.isMuted();
      } catch (err) {
        // Mute state is not readable everywhere; volume still reports.
      }
      return state;
    }

    function run(command, params /*, timeoutMs */) {
      params = params || {};
      try {
        switch (command) {
          case 'display.text': {
            var text = requireString(params, 'text');
            var title = optionalString(params, 'title');
            ui.showText({ title: title, text: text });
            return ok({ shown: true });
          }
          case 'display.image': {
            var url = requireString(params, 'url');
            if (!/^https?:\/\//i.test(url)) {
              return error('url must be an http(s) URL');
            }
            ui.showImage({ url: url, caption: optionalString(params, 'caption') });
            return ok({ shown: true, url: url });
          }
          case 'display.briefing': {
            var bTitle = requireString(params, 'title');
            var lines = params.lines;
            if (typeof lines === 'string') lines = lines.split('\n');
            if (!Array.isArray(lines)) {
              return error('missing or invalid parameter: lines (array of strings required)');
            }
            lines = lines.map(function (line) { return String(line); });
            ui.showBriefing({ title: bTitle, lines: lines });
            return ok({ shown: true, lines: lines.length });
          }
          case 'tv.volume.get':
            return ok(volumeState());
          case 'tv.volume.set': {
            var level = params.level;
            if (typeof level !== 'number' || !isFinite(level)) {
              return error('missing or invalid parameter: level (integer 0-100 required)');
            }
            tv.volume.set(level);
            return ok(volumeState());
          }
          case 'tv.volume.up': {
            tv.volume.up(optionalInt(params, 'step'));
            return ok(volumeState());
          }
          case 'tv.volume.down': {
            tv.volume.down(optionalInt(params, 'step'));
            return ok(volumeState());
          }
          case 'tv.mute': {
            var muted = params.muted;
            if (muted === undefined || muted === null) {
              muted = !tv.volume.isMuted();
            }
            if (typeof muted !== 'boolean') {
              return error('invalid parameter: muted (boolean required)');
            }
            tv.volume.setMuted(muted);
            return ok(volumeState());
          }
          case 'tv.launch_app': {
            var appId = requireString(params, 'app_id');
            return tv.launchApp(appId).then(
              function (result) { return ok(result); },
              function (err) { return error(err.message || String(err)); }
            );
          }
          case 'device.health': {
            var info = tv.deviceInfo();
            info.uptime_s = Math.round((Date.now() - startedAt) / 1000);
            if (deps.nodeId) info.node_id = deps.nodeId;
            if (deps.version) info.version = deps.version;
            return tv.storageInfo().then(function (storage) {
              if (storage) info.storage = storage;
              return ok(info);
            });
          }
          default:
            return error('unknown command: ' + command);
        }
      } catch (err) {
        return error(err && err.message ? err.message : String(err));
      }
    }

    return { run: run };
  }

  MG.executor = {
    COMMAND_SPECS: COMMAND_SPECS,
    createExecutor: createExecutor,
    ok: ok,
    error: error,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.executor;
})(typeof globalThis !== 'undefined' ? globalThis : this);
