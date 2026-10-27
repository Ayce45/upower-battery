import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Indicator from './indicator.js';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import UPowerGlib from 'gi://UPowerGlib';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
const xml = '<node>\
   <interface name="org.freedesktop.UPower.Device">\
      <property name="Type" type="u" access="read" />\
      <property name="State" type="u" access="read" />\
      <property name="Percentage" type="d" access="read" />\
      <property name="TimeToEmpty" type="x" access="read" />\
      <property name="TimeToFull" type="x" access="read" />\
      <property name="IsPresent" type="b" access="read" />\
      <property name="IconName" type="s" access="read" />\
   </interface>\
</node>';
const PowerManagerProxy = Gio.DBusProxy.makeProxyWrapper(xml);
const BUS_NAME = 'org.freedesktop.UPower';
// Ajout local : appareils hors UPower lus par commande (ex. jabridge pour un casque Jabra
// via dongle USB). Chaque ligne de sortie « Nom: 97% » donne un appareil.
const COMMANDS_FILE = GLib.build_filenamev([GLib.get_user_config_dir(), 'upower-battery', 'commands.json']);
const COMMAND_POLL_SECONDS = 120;


var Log = function (msg) {
	if (true) {
		console.log('[upower-battery] ' + msg);
	}
}

var LogError = function (msg) {
	console.log('[upower-battery] ' + msg);
}

export default class UpowerBatteryExtension extends Extension {
	constructor(metadata) {
		super(metadata);
		const proxy = new PowerManagerProxy(
			Gio.DBus.system,
			BUS_NAME,
			'/org/freedesktop/UPower');
		this._dbusCon = proxy.get_connection();
	}

	enable() {
		Log('Enable');
		this._indicator = new Indicator.Indicator(this);
		this._proxies = {};
		Main.panel.addToStatusArea('upowerBattery', this._indicator, 3, 'right');

		var iname = 'org.freedesktop.UPower';
		var sender = 'org.freedesktop.UPower';
		this._subIdAdd = this._dbusCon.signal_subscribe(sender, iname, 'DeviceAdded', null, null, 0, () => {
			Log('Device added')
			this._refresh();
		});
		this._subIdRem = this._dbusCon.signal_subscribe(sender, iname, 'DeviceRemoved', null, null, 0, () => {
			Log('Device removed')
			this._refresh();
		});
		this._once = GLib.timeout_add(
			GLib.PRIORITY_DEFAULT, 10,
			() => {
			  this._once = null;
			  this._refresh();
			  return false;
		});
		this._commandDevices = [];
		this._pollCommands();
		this._commandTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, COMMAND_POLL_SECONDS, () => {
			this._pollCommands();
			return GLib.SOURCE_CONTINUE;
		});
	}

	_refresh() {
		Log('Refresh')
		const devices = this._findDevices();
		devices.forEach((device, index) => {
			try {
				device.udevice.refresh_sync(null);
			} catch (error) {
				LogError('Error ' + error)
			}
		});
		this._update();
	}

	_update() {
		const devices = this._findDevices().concat(this._commandDevices ?? []);
		devices.sort((a, b) => (a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : ((a.path > b.path) ? 1 : -1)));
		this._indicator.refresh(devices);
	}

	_readCommands() {
		try {
			const [, contents] = GLib.file_get_contents(COMMANDS_FILE);
			return JSON.parse(new TextDecoder().decode(contents));
		} catch (error) {
			return [];
		}
	}

	async _pollCommands() {
		const devices = [];
		for (const entry of this._readCommands()) {
			const argv = entry.command.map((arg) => arg.replace(/^~(?=\/)/, GLib.get_home_dir()));
			try {
				const proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
				const stdout = await new Promise((resolve, reject) => {
					proc.communicate_utf8_async(null, null, (p, res) => {
						try {
							resolve(p.communicate_utf8_finish(res)[1] ?? '');
						} catch (error) {
							reject(error);
						}
					});
				});
				for (const line of stdout.split('\n')) {
					const match = line.match(/^\s*(.+?):\s*(\d+)\s*%/);
					if (match) {
						devices.push({
							name: match[1],
							path: 'command:' + match[1],
							icon: entry.icon || 'battery-full-symbolic',
							percentage: parseInt(match[2], 10),
						});
					}
				}
			} catch (error) {
				LogError('Command error ' + argv.join(' ') + ': ' + error);
			}
		}
		if (!this._indicator) {
			return;
		}
		this._commandDevices = devices;
		this._update();
	}

	_findDevices() {
		Log('Finding devices');
		const icons = {};
		icons[UPowerGlib.DeviceKind.MOUSE] = { icon: 'input-mouse-symbolic' };
		icons[UPowerGlib.DeviceKind.KEYBOARD] = { icon: 'input-keyboard-symbolic' };
		icons[UPowerGlib.DeviceKind.GAMING_INPUT] = { icon: 'input-gaming-symbolic' };
		icons[UPowerGlib.DeviceKind.TOUCHPAD] = { icon: 'input-touchpad-symbolic' };
		icons[UPowerGlib.DeviceKind.HEADSET] = { icon: 'audio-headset-symbolic' };
		icons[UPowerGlib.DeviceKind.HEADPHONES] = { icon: 'audio-headphones-symbolic' };
		icons[UPowerGlib.DeviceKind.BLUETOOTH_GENERIC] = { icon: 'bluetooth-symbolic' };
		icons[UPowerGlib.DeviceKind.SPEAKERS] = { icon: 'audio-speakers-symbolic' };
		icons[UPowerGlib.DeviceKind.PHONE] = { icon: 'smartphone-symbolic' };
		icons[UPowerGlib.DeviceKind.TABLET] = { icon: 'input-tablet-symbolic' };
		const devices = [];
		const upowerClient = UPowerGlib.Client.new_full(null);
		const udevices = upowerClient.get_devices();
		const newProxies = {}
		for (let i = 0; i < udevices.length; i++) {
			const udevice = udevices[i];
			if (udevice.kind in icons) {
				if (udevice.state != UPowerGlib.DeviceState.UNKNOWN || udevice.native_path.includes("bluez")) {
					const icon = icons[udevice.kind];
					Log('Found device: ' + icon.icon + ' | ' + udevice.native_path);
					devices.push({
						name: udevice.model,
						path: udevice.native_path,
						icon: icon.icon,
						udevice: udevice,
						percentage: udevice.percentage,
					});
				}
				if (udevice.native_path in this._proxies) {
					newProxies[udevice.native_path] = this._proxies[udevice.native_path];
				} else {
					const proxy = new PowerManagerProxy(Gio.DBus.system,
						BUS_NAME,
						udevice.get_object_path()
					);
					const propertyChangedId = proxy.connect('g-properties-changed', () => {
						Log('Property changed for ' + udevice.model);
						this._update();
					});
					newProxies[udevice.native_path] = { proxy, propertyChangedId };
				}
			}
		}
		for (const [path, entry] of Object.entries(this._proxies)) {
			if (!(path in newProxies)) {
				entry.proxy.disconnect(entry.propertyChangedId);
			}
		}
		this._proxies = newProxies;
		devices.sort((a, b) => (a.name > b.name) ? 1 : ((b.name > a.name) ? -1 : ((a.path > b.path) ? 1 : -1)));
		return devices;
	}

	_disconnectProxies() {
		for (const { proxy, propertyChangedId } of Object.values(this._proxies ?? {})) {
			proxy.disconnect(propertyChangedId);
		}
		this._proxies = {};
	}

	disable() {
		Log('Disable');
		this._dbusCon.signal_unsubscribe(this._subIdAdd);
		this._dbusCon.signal_unsubscribe(this._subIdRem);
		this._disconnectProxies();
		if (this._indicator) {
			this._indicator.destroy();
			this._indicator = null;
		}
		if (this._once) {
			GLib.Source.remove(this._once);
			this._once = null;
		}
		if (this._commandTimer) {
			GLib.Source.remove(this._commandTimer);
			this._commandTimer = null;
		}
		this._commandDevices = [];
	}
}

function init(meta) {
	return new UpowerBatteryExtension(meta.uuid);
}
