const Me = imports.misc.extensionUtils.getCurrentExtension();

const Focus = Me.imports.focus;
const { Gio, GLib, Meta, Shell, St } = imports.gi;
const { bind } = imports.lang;
const { ORIENTATION_HORIZONTAL, ORIENTATION_VERTICAL, ok, ok_or_else, cursor_rect, is_move_op, log } = Me.imports.lib;
const { _defaultCssStylesheet, uiGroup, wm } = imports.ui.main;
const { Keybindings } = Me.imports.keybindings;
const { ShellWindow } = Me.imports.window;
const { WindowSearch } = Me.imports.window_search;
const Tags = Me.imports.tags;
const { AutoTiler, TilingFork, TilingNode } = Me.imports.auto_tiler;
const { Tiler } = Me.imports.tiling;
const { ExtensionSettings, Settings } = Me.imports.settings;
const { Storage, World, entity_eq } = Me.imports.ecs;

const MODE_AUTO_TILE = 0;
const MODE_DEFAULT = 1;

const WINDOW_CHANGED_POSITION = 0;
const WINDOW_CHANGED_SIZE = 1;

var GrabOp = class GrabOp {
    constructor(entity, rect) {
        this.entity = entity;
        this.rect = rect;
    }

    movement(new_rect) {
        return [
            new_rect.x - this.rect.x,
            new_rect.y - this.rect.y,
            new_rect.width - this.rect.width,
            new_rect.height - this.rect.height
        ];
    }
}

var Ext = class Ext extends World {
    constructor() {
        super();

        // Misc

        this.grab_op = null;
        this.keybindings = new Keybindings(this);
        this.settings = new ExtensionSettings();
        this.overlay = new St.BoxLayout({ style_class: "tile-preview", visible: false });
        this.mode = MODE_DEFAULT;

        // Storages

        this.attached = null;
        this.icons = this.register_storage();
        this.ids = this.register_storage();
        this.monitors = this.register_storage();
        this.names = this.register_storage();
        this.tilable = this.register_storage();
        this.windows = this.register_storage();

        // Sub-worlds

        this.auto_tiler = null;

        // Dialogs

        this.window_search = new WindowSearch(this);

        // Systems

        this.focus_selector = new Focus.FocusSelector(this);
        this.tiler = new Tiler(this);

        // Signals

        global.display.connect('window_created', (_, win) => this.on_window_create(win));
        global.display.connect('grab-op-begin', (_, _display, win, op) => this.on_grab_start(win, op));
        global.display.connect('grab-op-end', (_, _display, win, op) => this.on_grab_end(win, op));

        for (const window of this.tab_list(Meta.TabList.NORMAL, null)) {
            this.on_window_create(window);
        }

        // Modes

        if (this.settings.tile_by_default()) {
            log(`tile by default enabled`);
            this.mode = MODE_AUTO_TILE;
            this.attached = this.register_storage();
            this.auto_tiler = new AutoTiler();
        }
    }

    activate_window(window) {
        ok(window, (win) => win.activate());
    }

    active_window_list() {
        let workspace = global.workspace_manager.get_active_workspace();
        return this.tab_list(Meta.TabList.NORMAL, workspace);
    }

    /**
     * Swap window associations in the auto-tiler
     *
     * @param {Entity} a
     * @param {Entity} b
     *
     * Call this when a window has swapped positions with another, so that we
     * may update the associations in the auto-tiler world.
     */
    attach_swap(a, b) {
        const a_ent = this.attached.remove(a);
        const b_ent = this.attached.remove(b);

        if (a_ent) {
            this.auto_tiler.forks.with(a_ent, (fork) => fork.replace_window(a, b));
            this.attached.insert(b, a_ent);
        }

        if (b_ent) {
            this.auto_tiler.forks.with(b_ent, (fork) => fork.replace_window(b, a));
            this.attached.insert(a, b_ent);
        }
    }

    /**
     * Attaches `win` to an optionally-given monitor
     *
     * @param {ShellWindow} win The window to attach
     * @param {Number} monitor The index of the monitor to attach to
     */
    attach_to_monitor(win, monitor = null) {
        const [entity, fork] = this.auto_tiler.create_fork(TilingNode.window(win.entity));
        log(`attached (${win.entity}) to (${entity})`);
        this.attached.insert(win.entity, entity);

        log(this.auto_tiler.display('\n\n'));

        this.attach_update(
            fork,
            this.monitor_work_area(monitor ? monitor : global.display.get_current_monitor())
        );
    }

    /**
     * Tiles a window into another
     *
     * @param {ShellWindow} atachee The window to attach to
     * @param {ShellWindow} attacher The window to attach with
     */
    attach_to_window(atachee, attacher) {
        log(`attempting to attach ${attacher.name()} to ${atachee.name()}`);

        let result = this.auto_tiler.attach_window(
            atachee.entity,
            attacher.entity,
            (fork_entity, association) => {
                log(`attached (${association}) to ${fork_entity}`);
                this.attached.insert(association, fork_entity);
            }
        );

        log(this.auto_tiler.display('\n\n'));

        if (result) {
            const [entity, fork] = result;
            this.attach_update(fork, atachee.meta.get_frame_rect());
            return true;
        }

        return false;
    }

    /**
     * Sets the orientation of a tiling fork, and this it according to the given area.
     *
     * @param {Entity} fork The fork that needs to be retiled
     * @param {[u32, 4]} area The area to tile with
     */
    attach_update(fork, area) {
        fork.set_orientation(area.width > area.height ? ORIENTATION_HORIZONTAL : ORIENTATION_VERTICAL)
            .tile(this.auto_tiler, this, [area.x, area.y, area.width, area.height]);
    }

    /**
     * Detaches the window from a tiling branch, if it is attached to one.
     *
     * @param {Entity} win
     */
    detach_window(win, name) {
        this.attached.take_with(win, (prev_fork) => {
            this.auto_tiler.detach(this, prev_fork, win, name);
            log(this.auto_tiler.display('\n\n'));
        });
    }

    /**
     * Automatically tiles a window into the window tree.
     *
     * @param {ShellWindow} win The window to be tiled
     *
     * ## Implementation Notes
     *
     * - First tries to tile into the focused windowo
     * - Then tries to tile onto a monitor
     */
    auto_tile(win) {
        let onto = this.focus_window();
        if (onto === win) onto = null;

        let current = null
        if (!(onto && onto.is_tilable())) {
            current = global.display.get_current_monitor();
            onto = this.largest_window_on(current);
            if (onto == win) onto = null;
        }

        this.detach_window(win.entity, win.name());

        if (!(onto && this.attach_to_window(onto, win))) {
            this.attach_to_monitor(win, current);
        }
    }

    /**
     * Performed when a window that has been dropped is destined to be tiled
     *
     * @param {ShellWindow} win The window that was dropped
     *
     * ## Implementation Notes
     *
     * - If the window is dropped onto a window, tile onto it
     * - If no window is present, tile onto the monitor
     */
    auto_tile_on_drop(win) {
        if (this.dropped_on_sibling(win.entity)) return;

        this.detach_window(win.entity, win.name());

        for (const found of this.windows_at_pointer()) {
            if (found == win) continue;
            this.attach_to_window(found, win);
            return;
        }

        this.attach_to_monitor(win, win.meta.get_monitor());
    }

    connect_window(win) {
        // win.meta.connect('position-changed', () => this.on_window_changed(win, WINDOW_CHANGED_POSITION));
        // win.meta.connect('size-changed', () => this.on_window_resized(win));

        win.meta.connect('focus', () => this.on_focused(win));
    }

    /**
     * Swaps the location of two windows if the dropped window was dropped onto its sibling
     *
     * @param {Entity} win
     *
     * @return bool
     */
    dropped_on_sibling(win) {
        const fork_entity = this.attached.get(win);
        if (fork_entity) {
            for (const found of this.windows_at_pointer()) {
                const fentity = found.entity;
                if (fentity == win) continue;
                const found_fork = this.attached.get(fentity);
                if (found_fork && found_fork == fork_entity) {
                    log(`${this.names.get(win)} was dropped onto ${found.name()}`);

                    const fork = this.auto_tiler.forks.get(fork_entity);

                    if (fork.left.entity == win) {
                        fork.left.entity = fentity;
                        fork.right.entity = win;
                    } else {
                        fork.left.entity = win;
                        fork.right.entity = fentity;
                    }

                    fork.tile(this.auto_tiler, this, fork.area);

                    return true;
                }
            }
        }

        return false;
    }

    focus_window() {
        return this.get_window(global.display.get_focus_window());
    }

    /// Fetches the window component from the entity associated with the metacity window metadata.
    get_window(meta) {
        // TODO: Deprecate this
        let entity = this.window(meta);
        return entity ? this.windows.get(entity) : null;
    }

    /// Finds the largest window on a monitor.
    largest_window_on(monitor) {
        let largest = null;
        let largest_size = 0;

        for (const entity of this.monitors.find((m) => m == monitor)) {
            this.windows.with(entity, (window) => {
                let rect = window.meta.get_frame_rect();
                let window_size = rect.width * rect.height;
                if (largest_size < window_size) {
                    largest = window;
                    largest_size = window_size;
                }
            });
        }

        return largest;
    }

    load_settings() {
        this.tiler.set_gap(settings.gap());
    }

    monitor_work_area(monitor) {
        return global.display.get_workspace_manager()
            .get_active_workspace()
            .get_work_area_for_monitor(monitor)
    }

    on_destroy(win) {
        log(`destroying window (${win.entity}): ${win.name()}`);

        if (this.auto_tiler) this.detach_window(win.entity, win.name());

        this.delete_entity(win.entity);
    }

    /**
     * Triggered when a window has been focused
     *
     * @param {SHellWindow} win
     */
    on_focused(win) {
        log(`focused window (${win.name()}):\n\
            entity: ${win.entity}\n\
            fork: ${this.attached.get(win.entity)}`);
    }

    /**
     * Triggered when a grab operation has been ended
     *
     * @param {Meta.Window} meta
     * @param {*} op
     */
    on_grab_end(meta, op) {
        let win = this.get_window(meta);

        if (win && this.grab_op && entity_eq(this.grab_op.entity, win.entity)) {
            let crect = win.meta.get_frame_rect()
            const movement = this.grab_op.movement(crect);

            if (movement[0] != 0 || movement[1] != 0) {
                log(`win: ${win.name()}; op: ${op}; from \
                    (${this.grab_op.rect.x},${this.grab_op.rect.y}) to \
                    (${crect.x},${crect.y})`);

                this.on_monitor_changed(win, (changed_from, changed_to) => {
                    log(`window ${win.name()} moved from display ${changed_from} to ${changed_to}`);
                    this.monitors.insert(win.entity, changed_to);
                });

                if (this.mode == MODE_AUTO_TILE) {
                    if (is_move_op(op)) this.auto_tile_on_drop(win);
                } else {
                    this.tiler.snap(win);
                }
            }
        }
    }

    /**
     * Triggered when a grab operation has been started
     *
     * @param {Meta.Window} meta
     * @param {*} op
     */
    on_grab_start(meta, op) {
        let win = this.window(meta);
        if (win) {
            let rect = meta.get_frame_rect();
            this.grab_op = new GrabOp(win, rect);
        }
    }

    /// Handles the event of a window moving from one monitor to another.
    on_monitor_changed(win, func) {
        let expected_monitor = this.monitors.get(win.entity);
        let actual_monitor = win.meta.get_monitor();
        if (expected_monitor != actual_monitor) {
            func(expected_monitor, actual_monitor);
        }
    }

    on_window_create(window) {
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            let win = this.get_window(window);
            let actor = window.get_compositor_private();
            if (win && actor) {
                actor.connect('destroy', () => this.on_destroy(win));

                if (win.is_tilable()) {
                    this.connect_window(win);
                }
            }

            return false;
        });
    }

    set_overlay(rect) {
        this.overlay.x = rect.x;
        this.overlay.y = rect.y;
        this.overlay.width = rect.width;
        this.overlay.height = rect.height;
    }

    // Snaps all windows to the window grid
    snap_windows() {
        log(`snapping windows`);
        for (const window of this.windows.iter_values()) {
            if (window.is_tilable()) this.tiler.snap(window);
        }
    }

    tab_list(tablist, workspace) {
        return global.display.get_tab_list(tablist, workspace).map((win) => this.get_window(win));
    }

    tiled_windows() {
        return this.entities.filter((entity) => this.contains_tag(entity, Tags.Tiled));
    }

    /// Fetches the window entity which is associated with the metacity window metadata.
    window(meta) {
        if (!meta) return null;

        let id = meta.get_stable_sequence();

        // Locate the window entity with the matching ID
        let entity = this.ids.find((comp) => comp == id).next().value;

        // If not found, create a new entity with a ShellWindow component.
        if (!entity) {
            entity = this.create_entity();

            let win = new ShellWindow(entity, meta, this);

            this.windows.insert(entity, win);
            this.ids.insert(entity, id);
            this.monitors.insert(entity, win.meta.get_monitor());

            log(`added window (${win.entity}): ${win.name()}: ${id}`);
            if (this.mode == MODE_AUTO_TILE && win.is_tilable()) this.auto_tile(win);
        }

        return entity;
    }

    /// Returns the window(s) that the mouse pointer is currently hoving above.
    * windows_at_pointer() {
        let cursor = cursor_rect();
        let monitor = global.display.get_monitor_index_for_rect(cursor);

        for (const entity of this.monitors.find((m) => m == monitor)) {
            let window = this.windows.with(entity, (window) => {
                return window.meta.get_frame_rect().contains_rect(cursor) ? window : null;
            });

            if (window) yield window;
        }
    }
}

var ext = null;

function init() {
    log("init");

    ext = new Ext();
    uiGroup.add_actor(ext.overlay);

    // Code to execute after the shell has finished initializing everything.
    GLib.idle_add(GLib.PRIORITY_LOW, () => {
        if (ext.mode == MODE_DEFAULT) ext.snap_windows();
        return false;
    });
}

function enable() {
    log("enable");

    load_theme();

    uiGroup.add_actor(ext.overlay);

    ext.keybindings.enable(ext.keybindings.global)
        .enable(ext.keybindings.window_focus)
}

function disable() {
    log("disable");

    uiGroup.remove_actor(ext.overlay);

    ext.tiler.exit();

    ext.keybindings.disable(ext.keybindings.global)
        .disable(ext.keybindings.window_focus)

    ext = null;
}

// Supplements the GNOME Shell theme with the extension's theme.
function load_theme() {
    try {
        let theme = new St.Theme({
            application_stylesheet: Gio.File.new_for_path(Me.path + "/stylesheet.css"),
            theme_stylesheet: _defaultCssStylesheet,
        });

        St.ThemeContext.get_for_stage(global.stage).set_theme(theme);
    } catch (e) {
        log("stylesheet: " + e);
    }
}
