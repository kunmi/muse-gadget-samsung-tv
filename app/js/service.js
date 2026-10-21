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
 * Port of the Muse Gadget SDK's linux/src/musegadget/service.py: keep a
 * paired device connected to its Muse.
 *
 * Each round fetches the leased VMs with the device token (which also
 * yields a fresh per-VM bearer), connects to the default VM and serves
 * commands until the connection ends. Failures back off exponentially
 * (2 s base, 60 s ceiling; auth outcomes impose a 15 s floor). A session
 * that stayed registered for at least 30 s resets the backoff. The device
 * token is rotated at 3 h of age (tokens live about 4 h), and immediately
 * if the API rejects it; a refresh answered 401 deletes the pairing.
 */
(function (root) {
  'use strict';
  var MG = root.MG = root.MG || {};
  var museApi = MG.museApi;
  var linkSessionModule = MG.linkSession;
  var storeModule = MG.store;

  var DEFAULT_NOISE_HOST = 'hatch.metaaivm.com';
  var BACKOFF_BASE_S = 2.0;
  var BACKOFF_MAX_S = 60.0;
  var AUTH_BACKOFF_MIN_S = 15.0;
  var HEALTHY_SESSION_S = 30.0;
  var UNPAIRED_POLL_S = 30.0;
  var TOKEN_REFRESH_AGE_S = 3 * 3600;
  var TOKEN_RETRY_S = 300;

  function Backoff() {
    this.failures = 0;
    this.floor = 0;
  }

  Backoff.prototype.nextDelay = function () {
    var delay = Math.min(BACKOFF_BASE_S * Math.pow(2, Math.min(this.failures, 16)), BACKOFF_MAX_S);
    this.failures += 1;
    return Math.max(delay, this.floor);
  };

  Backoff.prototype.reset = function () {
    this.failures = 0;
    this.floor = 0;
  };

  // opts: {identity, store, runCommand, commands, version, log?, onState?,
  //        wsFactory?, nowFn?}
  // onState(state, detail): state is one of
  //   'unpaired' | 'connecting' | 'registered' | 'waiting' | 'stopped'
  function GadgetService(opts) {
    this._identity = opts.identity;
    this._store = opts.store;
    this._runCommand = opts.runCommand;
    this._commands = opts.commands;
    this._version = opts.version;
    this._log = opts.log || function () {};
    this._onState = opts.onState || function () {};
    this._wsFactory = opts.wsFactory || null;
    this._now = opts.nowFn || function () { return Date.now() / 1000; };
    this._stopped = false;
    this._stopResolve = null;
    this._lastRefreshAttempt = -Infinity;
    this._sdkTokenChangeWarned = false;
    this._current = null;
  }

  GadgetService.prototype.start = function () {
    if (this._runningLoop) return this._runningLoop;
    var self = this;
    this._stopPromise = new Promise(function (resolve) { self._stopResolve = resolve; });
    this._runningLoop = this._run().catch(function (err) {
      self._log('service loop failed: ' + (err && err.stack || err));
    });
    return this._runningLoop;
  };

  GadgetService.prototype.stop = function () {
    this._stopped = true;
    if (this._current) this._current.stop();
    if (this._stopResolve) this._stopResolve();
    this._onState('stopped', {});
  };

  GadgetService.prototype.isStopped = function () {
    return this._stopped;
  };

  // Ends the current session (if any) so the loop re-reads pairing state —
  // used after the user unpairs or imports new credentials from the UI.
  GadgetService.prototype.disconnectSession = function () {
    if (this._current) this._current.stop();
  };

  // Mirrors service.py's local-socket request rule: only a registered
  // session can carry chat.
  GadgetService.prototype.sendChat = function (message, sessionId) {
    var session = this._current;
    if (!session || !session.isRegistered()) {
      return Promise.reject(new Error('not connected to the Muse'));
    }
    return session.sendChat(message, sessionId);
  };

  GadgetService.prototype._sleep = function (seconds) {
    var self = this;
    return Promise.race([
      new Promise(function (resolve) { setTimeout(resolve, seconds * 1000); }),
      this._stopPromise,
    ]).then(function () { return self._stopped; });
  };

  GadgetService.prototype._run = async function () {
    var backoff = new Backoff();
    while (!this._stopped) {
      var pairing = this._store.getPairing();
      if (!pairing) {
        this._onState('unpaired', {});
        if (await this._sleep(UNPAIRED_POLL_S)) break;
        continue;
      }
      this._warnIfSdkTokenChanged(pairing);
      pairing = await this._maybeRefresh(pairing, false);
      if (this._stopped) break;
      if (pairing === null) {
        if (await this._sleep(TOKEN_RETRY_S)) break;
        continue;
      }

      var api = museApi.apiRoot(pairing.api_url_v2 || '');
      var fetched = await museApi.fetchVms(pairing.access_token, api);
      if (this._stopped) break;
      if (fetched.status === 401) {
        this._log('device token rejected by the API; refreshing');
        if ((await this._maybeRefresh(pairing, true)) === null) {
          if (await this._sleep(TOKEN_RETRY_S)) break;
        }
        continue;
      }
      var vms = fetched.vms;
      var vm = null;
      for (var i = 0; i < vms.length; i++) {
        if (vms[i].is_default) { vm = vms[i]; break; }
      }
      if (!vm && vms.length) vm = vms[0];
      if (!vm) {
        var noVmDelay = backoff.nextDelay();
        this._onState('waiting', { delay_s: noVmDelay, reason: 'no VMs available' });
        if (await this._sleep(noVmDelay)) break;
        continue;
      }

      var sessionResult = await this._session(vm, pairing);
      var outcome = sessionResult.outcome;
      var lasted = sessionResult.lasted;
      if (this._stopped || outcome === linkSessionModule.Outcome.STOPPED) break;
      if (outcome === linkSessionModule.Outcome.UNPAIRED) {
        this._store.clearPairing();
        this._onState('unpaired', {});
        this._log('pairing removed; pair again to set up');
        continue;
      }
      if (lasted >= HEALTHY_SESSION_S) backoff.reset();
      if (outcome === linkSessionModule.Outcome.AUTH_REJECTED ||
          outcome === linkSessionModule.Outcome.FORBIDDEN) {
        backoff.floor = AUTH_BACKOFF_MIN_S;
      }
      var delay = backoff.nextDelay();
      this._onState('waiting', { delay_s: delay, reason: outcome });
      this._log('reconnecting in ' + Math.round(delay) + 's');
      if (await this._sleep(delay)) break;
    }
    this._onState('stopped', {});
  };

  GadgetService.prototype._session = async function (vm, pairing) {
    var device = new linkSessionModule.DeviceDescription({
      nodeId: this._identity.nodeId,
      displayName: this._identity.displayName,
      version: this._version,
      commands: this._commands,
    });
    var session = new linkSessionModule.LinkSession({
      noiseHost: pairing.noise_host || DEFAULT_NOISE_HOST,
      vmId: vm.vm_id || vm.vm_name,
      vmAuthToken: vm.vm_auth_token,
      device: device,
      runCommand: this._runCommand,
      wsFactory: this._wsFactory,
      log: this._log,
      nowFn: this._now,
    });
    var self = this;
    session._onRegistered = function () {
      self._onState('registered', { vm: vm.vm_name || vm.vm_id });
    };
    this._onState('connecting', { vm: vm.vm_name || vm.vm_id });
    this._log('connecting to ' + (vm.vm_name || vm.vm_id));
    this._current = session;
    var outcome;
    try {
      outcome = await session.run();
    } catch (err) {
      this._log('session failed: ' + (err && err.message));
      outcome = linkSessionModule.Outcome.CLOSED;
    } finally {
      this._current = null;
    }
    var lasted = session.wasRegisteredAt ? this._now() - session.wasRegisteredAt : 0;
    this._log('session ended: ' + outcome + ' after ' + Math.round(lasted) + 's registered');
    return { outcome: outcome, lasted: lasted };
  };

  GadgetService.prototype._warnIfSdkTokenChanged = function (pairing) {
    // Muse records a device's SDK token only when it pairs, so a token set
    // afterwards takes effect only once the device pairs again.
    if (this._sdkTokenChangeWarned) return;
    var paired = pairing.sdk_token_hint;
    if (paired === undefined || paired === null) return;
    var current = storeModule.sdkTokenHint(this._sdkTokenOrNull());
    if (paired !== current) {
      this._sdkTokenChangeWarned = true;
      this._log('paired with SDK token ' + paired + ', not this one; pair again to use it');
    }
  };

  GadgetService.prototype._sdkTokenOrNull = function () {
    try {
      return this._store.getSdkToken();
    } catch (err) {
      return null;
    }
  };

  // Returns the current pairing, rotating tokens first if they are due;
  // null only when a due refresh failed and the old token should not be
  // used yet. The record is deleted when the pairing itself was revoked.
  GadgetService.prototype._maybeRefresh = async function (pairing, force) {
    var age = this._now() - (pairing.access_token_saved_at || 0);
    if (!force && age < TOKEN_REFRESH_AGE_S) return pairing;
    if (!force && this._now() - this._lastRefreshAttempt < TOKEN_RETRY_S) return pairing;
    this._lastRefreshAttempt = this._now();
    var result = await museApi.refreshDeviceToken(
      pairing.refresh_token,
      this._identity.nodeId,
      museApi.apiRoot(pairing.api_url_v2 || ''),
      this._sdkTokenOrNull()
    );
    if (result.tokens) {
      var updated = {};
      Object.keys(pairing).forEach(function (k) { updated[k] = pairing[k]; });
      updated.access_token = result.tokens.access_token;
      updated.refresh_token = result.tokens.refresh_token;
      updated.access_token_saved_at = Math.floor(this._now());
      this._store.setPairing(updated);
      this._log('device token rotated');
      return updated;
    }
    if (result.status === 401) {
      this._store.clearPairing();
      this._onState('unpaired', {});
      this._log('pairing revoked; pair again to set up');
      return null;
    }
    // Transient failure: keep using the current token while it still works.
    return force ? null : pairing;
  };

  MG.service = {
    GadgetService: GadgetService,
    Backoff: Backoff,
    DEFAULT_NOISE_HOST: DEFAULT_NOISE_HOST,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = MG.service;
})(typeof globalThis !== 'undefined' ? globalThis : this);
