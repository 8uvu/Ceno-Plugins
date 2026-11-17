(() => { const module = { exports: {} }; const exports = module.exports; "use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// plugins/streaks/js/index.tsx
var index_exports = {};
__export(index_exports, {
  currentStreak: () => currentStreak,
  dayKey: () => dayKey,
  default: () => index_default,
  ranked: () => ranked,
  record: () => record,
  shiftDay: () => shiftDay
});
module.exports = __toCommonJS(index_exports);
var import_design = (function () { const __g = () => { try { return (valenced.discord && valenced.discord.design) || {}; } catch (error) { return {}; } }; const __ns = { get default() { return __g().default }, get Design() { return __g().Design } }; return typeof Proxy === 'function' ? new Proxy(__ns, { get(target, key) { return key in target ? target[key] : __g()[key]; } }) : __ns; })();
var import_flux = (function () { const __g = () => { try { return (valenced.discord && valenced.discord.flux) || {}; } catch (error) { return {}; } }; const __ns = { get default() { return __g().default }, get Stores() { return __g().Stores }, get getStore() { return __g().getStore }, get onFluxEventDispatched() { return __g().onFluxEventDispatched }, get onAnyFluxEventDispatched() { return __g().onAnyFluxEventDispatched } }; return typeof Proxy === 'function' ? new Proxy(__ns, { get(target, key) { return key in target ? target[key] : __g()[key]; } }) : __ns; })();
var import_react_native2 = (function () { const __g = () => { try { return (valenced.react && valenced.react.ReactNative) || {}; } catch (error) { return {}; } }; const __ns = { get default() { return __g().default }, get View() { return __g().View }, get Text() { return __g().Text }, get ScrollView() { return __g().ScrollView }, get Pressable() { return __g().Pressable }, get Appearance() { return __g().Appearance }, get TextInput() { return __g().TextInput }, get Switch() { return __g().Switch }, get Image() { return __g().Image }, get Modal() { return __g().Modal }, get FlatList() { return __g().FlatList }, get StyleSheet() { return __g().StyleSheet }, get Platform() { return __g().Platform }, get Dimensions() { return __g().Dimensions }, get Alert() { return __g().Alert }, get Linking() { return __g().Linking }, get Animated() { return __g().Animated }, get Vibration() { return __g().Vibration }, get RefreshControl() { return __g().RefreshControl }, get SafeAreaView() { return __g().SafeAreaView }, get TouchableOpacity() { return __g().TouchableOpacity }, get ActivityIndicator() { return __g().ActivityIndicator }, get KeyboardAvoidingView() { return __g().KeyboardAvoidingView } }; return typeof Proxy === 'function' ? new Proxy(__ns, { get(target, key) { return key in target ? target[key] : __g()[key]; } }) : __ns; })();

// plugins/_shared/theme.ts
var import_common = (function () { const __g = () => { try { return (valenced.discord && valenced.discord.common) || {}; } catch (error) { return {}; } }; const __ns = { get default() { return __g().default }, get Tokens() { return __g().Tokens }, get Logger() { return __g().Logger }, get Constants() { return __g().Constants } }; return typeof Proxy === 'function' ? new Proxy(__ns, { get(target, key) { return key in target ? target[key] : __g()[key]; } }) : __ns; })();
var import_react_native = (function () { const __g = () => { try { return (valenced.react && valenced.react.ReactNative) || {}; } catch (error) { return {}; } }; const __ns = { get default() { return __g().default }, get View() { return __g().View }, get Text() { return __g().Text }, get ScrollView() { return __g().ScrollView }, get Pressable() { return __g().Pressable }, get Appearance() { return __g().Appearance }, get TextInput() { return __g().TextInput }, get Switch() { return __g().Switch }, get Image() { return __g().Image }, get Modal() { return __g().Modal }, get FlatList() { return __g().FlatList }, get StyleSheet() { return __g().StyleSheet }, get Platform() { return __g().Platform }, get Dimensions() { return __g().Dimensions }, get Alert() { return __g().Alert }, get Linking() { return __g().Linking }, get Animated() { return __g().Animated }, get Vibration() { return __g().Vibration }, get RefreshControl() { return __g().RefreshControl }, get SafeAreaView() { return __g().SafeAreaView }, get TouchableOpacity() { return __g().TouchableOpacity }, get ActivityIndicator() { return __g().ActivityIndicator }, get KeyboardAvoidingView() { return __g().KeyboardAvoidingView } }; return typeof Proxy === 'function' ? new Proxy(__ns, { get(target, key) { return key in target ? target[key] : __g()[key]; } }) : __ns; })();
function activeBase() {
  var _a, _b;
  try {
    if (((_b = (_a = import_react_native.Appearance) == null ? void 0 : _a.getColorScheme) == null ? void 0 : _b.call(_a)) === "light") return "light";
  } catch {
  }
  return "dark";
}
function token(name) {
  var _a, _b, _c, _d, _e;
  try {
    const module2 = import_common.Tokens;
    if (!module2) return void 0;
    const definition = (_a = module2 == null ? void 0 : module2.SemanticColor) == null ? void 0 : _a[name];
    const resolve = (_c = (_b = module2 == null ? void 0 : module2.default) == null ? void 0 : _b.internal) == null ? void 0 : _c.resolveSemanticColor;
    if (typeof resolve === "function" && definition) {
      return resolve(activeBase(), definition);
    }
    const colours = (_e = (_d = module2 == null ? void 0 : module2.default) == null ? void 0 : _d.colors) == null ? void 0 : _e[name];
    if (typeof colours === "string") return colours;
    if (typeof definition === "string") return definition;
  } catch {
  }
  return void 0;
}
var settingsScroll = {
  paddingHorizontal: 16,
  paddingTop: 16,
  gap: 16
};

// plugins/streaks/js/index.tsx
var import_jsx_runtime = (function () { const __g = () => { try { return ((valenced.react && (valenced.react.ReactJSXRuntime || valenced.react.jsxRuntime))) || {}; } catch (error) { return {}; } }; const __ns = { get default() { return __g().default }, get jsx() { return __g().jsx }, get jsxs() { return __g().jsxs }, get jsxDEV() { return __g().jsxDEV }, get Fragment() { return __g().Fragment } }; return typeof Proxy === 'function' ? new Proxy(__ns, { get(target, key) { return key in target ? target[key] : __g()[key]; } }) : __ns; })();
var DEFAULTS = { enabled: true, bothSides: true, conversations: {} };
var KEEP_DAYS = 400;
var DM = 1;
var GROUP_DM = 3;
function dayKey(at) {
  const date = new Date(at);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return date.getFullYear() + "-" + month + "-" + day;
}
function shiftDay(key, delta) {
  const [year, month, day] = key.split("-").map(Number);
  const date = new Date(year, (month != null ? month : 1) - 1, day != null ? day : 1);
  date.setDate(date.getDate() + delta);
  return dayKey(date.getTime());
}
function dayOf(conversation, key) {
  var _a;
  return (_a = conversation.days[key]) != null ? _a : { in: 0, out: 0 };
}
function active(day, bothSides) {
  return bothSides ? day.in > 0 && day.out > 0 : day.in + day.out > 0;
}
function currentStreak(conversation, today, bothSides) {
  let cursor = active(dayOf(conversation, today), bothSides) ? today : shiftDay(today, -1);
  let streak = 0;
  while (active(dayOf(conversation, cursor), bothSides)) {
    streak++;
    cursor = shiftDay(cursor, -1);
    if (streak > 1500) break;
  }
  return streak;
}
function prune(days) {
  const keys = Object.keys(days).sort().reverse().slice(0, KEEP_DAYS);
  const out = {};
  for (const key of keys) out[key] = days[key];
  return out;
}
function record(current, channelId, name, fromMe, at) {
  var _a, _b;
  const conversations = (_a = current.conversations) != null ? _a : {};
  const existing = conversations[channelId];
  const conversation = existing != null ? existing : {
    name,
    days: {},
    longest: 0
  };
  const key = dayKey(at);
  const day = dayOf(conversation, key);
  const nextDay = fromMe ? { in: day.in, out: day.out + 1 } : { in: day.in + 1, out: day.out };
  const days = prune({ ...conversation.days, [key]: nextDay });
  const streak = currentStreak(
    { ...conversation, days },
    key,
    current.bothSides !== false
  );
  return {
    conversations: {
      ...conversations,
      [channelId]: {
        name: name || conversation.name || "Conversation",
        days,
        longest: Math.max((_b = conversation.longest) != null ? _b : 0, streak)
      }
    }
  };
}
function ranked(current, today) {
  var _a;
  const bothSides = current.bothSides !== false;
  return Object.entries((_a = current.conversations) != null ? _a : {}).map(([id, conversation]) => {
    var _a2;
    return {
      id,
      name: conversation.name || "Conversation",
      streak: currentStreak(conversation, today, bothSides),
      longest: (_a2 = conversation.longest) != null ? _a2 : 0,
      today: dayOf(conversation, today)
    };
  }).sort((a, b) => b.streak - a.streak || b.longest - a.longest);
}
function store(name) {
  var _a;
  try {
    const proxied = (_a = import_flux.Stores) == null ? void 0 : _a[name];
    if (proxied) return proxied;
  } catch {
  }
  try {
    const lookup = import_flux.getStore;
    const direct = lookup == null ? void 0 : lookup(name);
    if (direct) return direct;
  } catch {
  }
  return null;
}
function selfId() {
  var _a, _b, _c, _d;
  try {
    return String((_d = (_c = (_b = (_a = store("UserStore")) == null ? void 0 : _a.getCurrentUser) == null ? void 0 : _b.call(_a)) == null ? void 0 : _c.id) != null ? _d : "");
  } catch {
    return "";
  }
}
function channelFor(id) {
  var _a, _b, _c;
  try {
    return (_c = (_b = (_a = store("ChannelStore")) == null ? void 0 : _a.getChannel) == null ? void 0 : _b.call(_a, id)) != null ? _c : null;
  } catch {
    return null;
  }
}
function isDm(channel) {
  if (!channel) return true;
  return channel.type === DM || channel.type === GROUP_DM || !channel.guild_id;
}
function nameOf(channel, id) {
  var _a;
  const recipient = (_a = channel == null ? void 0 : channel.recipients) == null ? void 0 : _a[0];
  if (recipient && typeof recipient === "object") {
    const user = recipient;
    const name = user.globalName || user.username;
    if (name) return name;
  }
  return (channel == null ? void 0 : channel.name) || "DM " + id.slice(-4);
}
function describe(entry) {
  const days = entry.streak === 1 ? "1 day" : entry.streak + " days";
  const today = entry.today.in + entry.today.out === 0 ? "nothing today yet" : "today " + entry.today.out + " sent, " + entry.today.in + " received";
  return days + " \u2014 " + today + " \xB7 best " + entry.longest;
}
var index_default = plugin({
  jsonStorage: { load: true, default: DEFAULTS },
  start({ cleanup, jsonStorage, logger }) {
    var _a;
    cleanup(
      // A listener only: the payload goes back untouched.
      (0, import_flux.onFluxEventDispatched)(
        "MESSAGE_CREATE",
        (payload) => {
          var _a2, _b, _c, _d, _e, _f;
          try {
            const current = (_a2 = jsonStorage.cache) != null ? _a2 : DEFAULTS;
            if (current.enabled === false || !payload) return payload;
            const message = payload.message;
            const channelId = (_b = message == null ? void 0 : message.channel_id) != null ? _b : payload.channelId;
            const author = (_c = message == null ? void 0 : message.author) == null ? void 0 : _c.id;
            if (!channelId || !author) return payload;
            const channel = channelFor(String(channelId));
            if (!isDm(channel)) return payload;
            const me = selfId();
            (_e = (_d = Promise.resolve(
              jsonStorage.set(
                record(
                  current,
                  String(channelId),
                  nameOf(channel, String(channelId)),
                  Boolean(me) && String(author) === me,
                  Date.now()
                )
              )
            )).catch) == null ? void 0 : _e.call(_d, () => {
            });
          } catch (error) {
            (_f = logger == null ? void 0 : logger.warn) == null ? void 0 : _f.call(logger, "[Streaks] skipped a message", error);
          }
          return payload;
        }
      )
    );
    (_a = logger == null ? void 0 : logger.log) == null ? void 0 : _a.call(logger, "[Streaks] started");
  },
  SettingsComponent({ api }) {
    var _a, _b, _c, _d;
    const settings = (_a = api.jsonStorage.use()) != null ? _a : DEFAULTS;
    const set = (patch) => {
      var _a2, _b2;
      return (_b2 = (_a2 = api.jsonStorage.set(patch)).catch) == null ? void 0 : _b2.call(_a2, () => {
      });
    };
    const today = dayKey(Date.now());
    const list = ranked(settings, today);
    const best = (_c = (_b = list[0]) == null ? void 0 : _b.streak) != null ? _c : 0;
    const D = (_d = import_design.Design) != null ? _d : {};
    const muted = token("TEXT_MUTED");
    const normal = token("TEXT_NORMAL");
    const row = (key, label, subLabel) => D.TableRow ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(D.TableRow, { label, subLabel }, key) : /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_react_native2.View, { style: { paddingVertical: 6 }, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react_native2.Text, { style: { color: normal }, children: label }),
      subLabel ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react_native2.Text, { style: { color: muted }, children: subLabel }) : null
    ] }, key);
    if (D.TableRowGroup) {
      return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_react_native2.ScrollView, { style: settingsScroll, children: [
        /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(D.TableRowGroup, { title: "Streaks", children: [
          D.TableSwitchRow ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            D.TableSwitchRow,
            {
              label: "Track streaks",
              subLabel: "Counts the days you and someone messaged each other. Stored on this device only.",
              value: settings.enabled !== false,
              onValueChange: (v) => set({ enabled: v })
            }
          ) : null,
          D.TableSwitchRow ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            D.TableSwitchRow,
            {
              label: "Both sides count",
              subLabel: "A day counts once each of you sent something. Turn off to count any message.",
              value: settings.bothSides !== false,
              onValueChange: (v) => set({ bothSides: v })
            }
          ) : null,
          D.TableRow ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
            D.TableRow,
            {
              label: "Reset all streaks",
              subLabel: "Deletes every conversation this plugin has recorded.",
              onPress: () => set({ conversations: {} })
            }
          ) : null
        ] }),
        /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
          D.TableRowGroup,
          {
            title: best > 0 ? "Best right now: " + best + (best === 1 ? " day" : " days") : "No streak running",
            children: list.length === 0 ? row("empty", "Nothing recorded yet.", "Send a message in a DM to start.") : list.map(
              (entry) => row(entry.id, entry.name, describe(entry))
            )
          }
        )
      ] });
    }
    return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_react_native2.ScrollView, { style: settingsScroll, children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react_native2.Text, { style: { color: normal, fontWeight: "bold", marginBottom: 8 }, children: "Streaks" }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        import_react_native2.Pressable,
        {
          accessibilityLabel: "Track streaks",
          onPress: () => set({ enabled: !(settings.enabled !== false) }),
          style: { paddingVertical: 8 },
          children: /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_react_native2.Text, { style: { color: normal }, children: [
            "Track streaks: ",
            settings.enabled !== false ? "on" : "off"
          ] })
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(
        import_react_native2.Pressable,
        {
          accessibilityLabel: "Reset all streaks",
          onPress: () => set({ conversations: {} }),
          style: { paddingVertical: 8 },
          children: /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react_native2.Text, { style: { color: normal }, children: "Reset all streaks" })
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react_native2.Text, { style: { color: normal, marginTop: 8 }, children: best > 0 ? "Best right now: " + best : "No streak running" }),
      list.length === 0 ? /* @__PURE__ */ (0, import_jsx_runtime.jsx)(import_react_native2.Text, { style: { color: muted, marginTop: 8 }, children: "Nothing recorded yet. Send a message in a DM to start." }) : list.map((entry) => /* @__PURE__ */ (0, import_jsx_runtime.jsxs)(import_react_native2.Text, { style: { color: normal, marginTop: 6 }, children: [
        entry.name,
        " \u2014 ",
        describe(entry)
      ] }, entry.id))
    ] });
  }
});
; const __pick = (function () { try { const found = []; const add = (v) => { try { if (v && typeof v === 'object' && (v.start || v.init || v.preInit || v.SettingsComponent)) found.push(v); } catch (e) {} }; try { add(module.exports && module.exports.default); } catch (e) {} try { add(typeof index_default === 'undefined' ? null : index_default); } catch (e) {} if (!found.length) { try { for (const k of Object.keys(module.exports || {})) add(module.exports[k]); } catch (e) {} } return found[0] || {}; } catch (e) { return {}; } })(); const __plugin = (__pick && typeof __pick === 'object' && Object.keys(__pick).length) ? __pick : ((module.exports && module.exports.default) || module.exports); try { const d = Object.getOwnPropertyDescriptor(module.exports || {}, 'default') || {}; console.log('[probe10] same=' + ((module.exports || {}).default === (typeof index_default === 'undefined' ? null : index_default)) + ' desc=' + (d.get ? 'getter' : 'value') + ' str=' + String((module.exports || {}).default).slice(0, 80) + ' pickKeys=' + Object.keys(__pick).length); } catch (e) { console.log('[probe10] err'); } const __out = { default: __plugin }; try { console.log('[probe8] out.default=' + typeof __out.default); } catch (e) {} return __out; })()