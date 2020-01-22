const Me = imports.misc.extensionUtils.getCurrentExtension();

const { Storage, World } = Me.imports.ecs;
const { ORIENTATION_HORIZONTAL, ORIENTATION_VERTICAL, log, orientation_as_str } = Me.imports.lib;

const FORK = 0;
const WINDOW = 1;

function node_variant_as_string(value) {
    return value == FORK ? "NodeVariant::Fork" : "NodeVariant::Window";
}

const XPOS = 0;
const YPOS = 1;
const WIDTH = 2;
const HEIGHT = 3;

var AutoTiler = class AutoTiler extends World {
    constructor() {
        super();

        this.forks = this.register_storage();
    }

    /**
     * Attaches a `new` window to the fork which `onto` is attached to.
     *
     * @param {Entity} onto_entity
     * @param {Entity} new_entity
     */
    attach_window(onto_entity, new_entity, assoc) {
        for (const [entity, fork] of this.forks.iter()) {
            if (fork.left.is_window(onto_entity)) {
                const node = TilingNode.window(new_entity);
                if (fork.right) {
                    const result = this.create_fork(fork.left, node);
                    fork.left = TilingNode.fork(result[0]);
                    result[1].set_parent(entity);
                    return this._attach(onto_entity, new_entity, assoc, entity, fork, result);
                } else {
                    fork.right = node;
                    return this._attach(onto_entity, new_entity, assoc, entity, fork, null);
                }
            } else if (fork.right && fork.right.is_window(onto_entity)) {
                const result = this.create_fork(fork.right, TilingNode.window(new_entity));
                fork.right = TilingNode.fork(result[0]);
                result[1].set_parent(entity);
                return this._attach(onto_entity, new_entity, assoc, entity, fork, result);
            }
        }

        return null;
    }

    /**
     * Create a new fork, where the left portion is a window `Entity`
     *
     * @param {Entity} window
     * @return [Entity, TilingFork]
     */
    create_fork(left, right = null) {
        const entity = this.create_entity();
        log(`created fork ${entity}`);
        let fork = new TilingFork(left, right);
        this.forks.insert(entity, fork);
        return [entity, fork];
    }

    detach(fork_entity, window, assoc) {
        let detach = null;
        let reflow_fork = null;
        let retach = null;

        this.forks.with(fork_entity, (fork) => {
            if (fork.left.is_window(window)) {
                fork.left = null;
                detach = [fork_entity, fork];

                if (fork.right) {
                    retach = fork.right;
                    fork.right = null;
                }
            } else if (fork.right && fork.right.is_window(window)) {
                retach = fork.left;
                detach = [fork_entity, fork];
            }
        });

        let removals = new Array();

        while (detach) {
            const [detach_entity, detach_fork] = detach;

            detach = null;

            if (detach_fork.parent) {
                removals.push(detach_entity);
                const entity = detach_fork.parent;
                reflow_fork = detach_fork;
                let fork = this.forks.get(entity);

                if (fork.left.is_fork(detach_entity)) {
                    if (retach) {
                        assoc(entity, retach.entity);
                        fork.left = retach;
                        retach = null;
                    } else {
                        detach = [entity, fork];
                        retach = fork.right;
                    }

                    fork.left = null;
                } else if (fork.right && fork.right.is_fork(detach_entity)) {
                    if (retach) {
                        assoc(entity, retach.entity);
                        fork.right = retach;
                        retach = null;
                    } else {
                        detach = [entity, fork];
                        retach = fork.right;
                    }
                }

                fork.left = null;
                fork.right = null;
            } else if (!detach_fork.left && !detach_fork.right) {
                log(`marking ${detach_entity} for removal`);
                removals.push(detach_entity);
            }
        }

        for (const entity of removals) {
            log(`deleting fork ${entity}`);
            this.delete_entity(entity);
        }

        return reflow_fork;
    }

    display(fmt) {
        for (const [entity, fork] of this.forks.iter()) {
            fmt += `fork (${entity}): ${fork.display('')}\n`;
        }

        return fmt;
    }

    _attach(onto_entity, new_entity, assoc, entity, fork, result) {
        if (result) {
            assoc(result[0], onto_entity);
            assoc(result[0], new_entity);
            return result;
        } else {
            assoc(entity, new_entity);
            return [entity, fork];
        }
    }
}

/**
 * A node within the `AutoTiler`, which may contain either windows and/or sub-forks.
 *
 * @param {Entity} left The window or fork attached to the left branch of this node
 * @param {Entity} right The window or fork attached to the right branch of this node
 * @param {f32} ratio The division of space between the left and right fork
 * @param {Orientation} orientation The direction to tile this fork
 */
var TilingFork = class TilingFork {
    constructor(left, right = null) {
        this.left = left;
        this.right = right;
        this.parent = null;
        this.ratio = .5;
        this.orientation = ORIENTATION_HORIZONTAL;
    }

    display(fmt) {
        fmt += '{ ';

        if (this.left) {
            fmt += `\n  left: ${this.left.display('')},`;
        }

        if (this.right) {
            fmt += `\n  right: ${this.right.display('')},`;
        }

        fmt += `\n  orientation: ${orientation_as_str(this.orientation)}\n}`;
        return fmt;
    }

    /**
     * Replaces the association of a window in a fork with another
     *
     * @param {Entity} a
     * @param {Entity} b
     */
    replace_window(a, b) {
        if (this.left.is_window(a)) {
            this.left.entity = b;
        } else if (this.right) {
            this.right.entity = b;
        } else {
            return false;
        }

        return true;
    }

    set_orientation(orientation) {
        this.orientation = orientation;
        return this;
    }

    set_parent(parent) {
        this.parent = parent;
        return this;
    }

    /**
     * Tiles all windows within this fork into the given area
     *
     * @param {AutoTiler} tiler The tiler which this fork is an entity of
     * @param {Ext} ext
     * @param {[u32, 4]} area
     */
    tile(tiler, ext, area) {
        /// Memorize our area for future tile reflows
        this.area = area;

        if (this.right) {
            const [l, p] = ORIENTATION_HORIZONTAL == this.orientation
                ? [WIDTH, XPOS] : [HEIGHT, YPOS];

            const length = Math.round(area[l] * this.ratio);
            // log(`length = ${length}`);

            let region = area.slice();

            region[l] = length - ext.tiler.half_gap;

            // log(`tiling left: ${region}`);
            this.left.tile(tiler, ext, region);

            region[p] = region[p] + length + ext.tiler.gap;
            region[l] = area[l] - length - ext.tiler.half_gap;

            // log(`tiling right: ${region}`);
            this.right.tile(tiler, ext, region);
        } else {
            this.left.tile(tiler, ext, area);
        }
    }
}
/**
 * A tiling node may either refer to a window entity, or another fork entity.
 *
 * @param {Number} kind Defines the kind of entity that has been stored
 * @param {Entity} entity May identify either a window entity, or a fork entity
 */
var TilingNode = class TilingNode {
    constructor(kind, entity) {
        this.kind = kind;
        this.entity = entity;
    }

    /**
     * Create a fork variant of a `TilingNode`
     *
     * @param {TilingFork} fork
     *
     * @return TilingNode
     */
    static fork(fork) {
        return new TilingNode(FORK, fork);
    }

    /**
     * Create the window variant of a `TilingNode`
     *
     * @param {Entity} window
     *
     * @return TilingNode
     */
    static window(window) {
        return new TilingNode(WINDOW, window);
    }

    /**
     * Calculates the area of this fork node
     *
     * @param {*} tiler The window tiler containing the fork this is a part of
     * @param {*} ext The world which contains the window entity's components
     *
     * @return [xpos, ypos, width, height]
     */
    area(tiler, ext) {
        if (FORK == this.kind) {
            return tiler.forks.get(this.entity).area(tiler, ext);
        } else {
            const rect = ext.windows.get(this.entity).meta.get_frame_rect();
            return [rect.x, rect.y, rect.width, rect.height];
        }
    }

    clone() {
        return new TilingNode(this.kind, this.entity);
    }

    display(fmt) {
        fmt += `{\n    kind: ${node_variant_as_string(this.kind)},\n    entity: (${this.entity})\n  }`;
        return fmt;
    }

    /**
     * Asks if this fork is the fork we are looking for
     *
     * @param {*} fork
     */
    is_fork(fork) {
        return FORK == this.kind && this.entity == fork;
    }

    /**
     * Asks if this window is the window we are looking for
     *
     * @param {*} window
     */
    is_window(window) {
        return WINDOW == this.kind && this.entity == window;
    }

    /**
     * Tiles all windows associated with this node
     *
     * @param {*} tiler
     * @param {*} ext
     * @param {*} area
     */
    tile(tiler, ext, area) {
        if (FORK == this.kind) {
            tiler.forks.get(this.entity).tile(tiler, ext, area);
        } else {
            const window = ext.windows.get(this.entity);

            window.move_snap({
                x: area[0],
                y: area[1],
                width: area[2],
                height: area[3]
            });
        }
    }
}
