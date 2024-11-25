import * as React from "react";
import type { GlobalState } from "./globalState";

import { NodeListComponent } from "./components/nodeList/nodeListComponent";
import { PropertyTabComponent } from "./components/propertyTab/propertyTabComponent";
import { Portal } from "./portal";
import { LogComponent, LogEntry } from "./components/log/logComponent";
import { DataStorage } from "core/Misc/dataStorage";
import type { Nullable } from "core/types";
import { MessageDialog } from "shared-ui-components/components/MessageDialog";
import { BlockTools } from "./blockTools";
import { PreviewManager } from "./components/preview/previewManager";
import { PreviewMeshControlComponent } from "./components/preview/previewMeshControlComponent";
import { PreviewAreaComponent } from "./components/preview/previewAreaComponent";
import { SerializationTools } from "./serializationTools";
import * as ReactDOM from "react-dom";
import type { IInspectorOptions } from "core/Debug/debugLayer";
import { CreatePopup } from "shared-ui-components/popupHelper";

import "./main.scss";
import { GraphCanvasComponent } from "shared-ui-components/nodeGraphSystem/graphCanvas";
import type { GraphNode } from "shared-ui-components/nodeGraphSystem/graphNode";
import { TypeLedger } from "shared-ui-components/nodeGraphSystem/typeLedger";
import type { IEditorData } from "shared-ui-components/nodeGraphSystem/interfaces/nodeLocationInfo";
import type { INodeData } from "shared-ui-components/nodeGraphSystem/interfaces/nodeData";
import { NodeGeometryBlock } from "core/Meshes/Node/nodeGeometryBlock";
import { GeometryOutputBlock } from "core/Meshes/Node/Blocks/geometryOutputBlock";
import type { NodeGeometryBlockConnectionPointTypes } from "core/Meshes/Node/Enums/nodeGeometryConnectionPointTypes";
import { GeometryInputBlock } from "core/Meshes/Node/Blocks/geometryInputBlock";
import { HistoryStack } from "shared-ui-components/historyStack";
import { SplitContainer } from "shared-ui-components/split/splitContainer";
import { Splitter } from "shared-ui-components/split/splitter";
import { ControlledSize, SplitDirection } from "shared-ui-components/split/splitContext";

interface IGraphEditorProps {
    globalState: GlobalState;
}

interface IGraphEditorState {
    showPreviewPopUp: boolean;
    message: string;
    isError: boolean;
}

interface IInternalPreviewAreaOptions extends IInspectorOptions {
    popup: boolean;
    original: boolean;
    explorerWidth?: string;
    inspectorWidth?: string;
    embedHostWidth?: string;
}

export class GraphEditor extends React.Component<IGraphEditorProps, IGraphEditorState> {
    private _graphCanvasRef: React.RefObject<GraphCanvasComponent>;
    private _diagramContainerRef: React.RefObject<HTMLDivElement>;
    private _graphCanvas: GraphCanvasComponent;

    private _historyStack: HistoryStack;

    private _previewManager: PreviewManager;
    private _mouseLocationX = 0;
    private _mouseLocationY = 0;
    private _onWidgetKeyUpPointer: any;

    private _previewHost: Nullable<HTMLElement>;
    private _popUpWindow: Window;

    appendBlock(dataToAppend: NodeGeometryBlock | INodeData, recursion = true) {
        return this._graphCanvas.createNodeFromObject(
            dataToAppend instanceof NodeGeometryBlock ? TypeLedger.NodeDataBuilder(dataToAppend, this._graphCanvas) : dataToAppend,
            (block: NodeGeometryBlock) => {
                if (this.props.globalState.nodeGeometry!.attachedBlocks.indexOf(block) === -1) {
                    this.props.globalState.nodeGeometry!.attachedBlocks.push(block);
                }

                if (block instanceof GeometryOutputBlock) {
                    this.props.globalState.nodeGeometry.outputBlock = block;
                }
            },
            recursion
        );
    }

    addValueNode(type: string) {
        const nodeType: NodeGeometryBlockConnectionPointTypes = BlockTools.GetConnectionNodeTypeFromString(type);

        const newInputBlock = new GeometryInputBlock(type, nodeType);
        return this.appendBlock(newInputBlock);
    }

    prepareHistoryStack() {
        const geometry = this.props.globalState.nodeGeometry;
        const globalState = this.props.globalState;

        const dataProvider = () => {
            SerializationTools.UpdateLocations(geometry, globalState);
            return geometry.serialize();
        };

        const applyUpdate = (data: any) => {
            globalState.stateManager.onSelectionChangedObservable.notifyObservers(null);
            geometry.parseSerializedObject(data);

            globalState.onResetRequiredObservable.notifyObservers(false);
        };

        // Create the stack
        this._historyStack = new HistoryStack(dataProvider, applyUpdate);
        this._historyStack.isEnabled = DataStorage.ReadBoolean("UndoRedo", true);
        globalState.stateManager.historyStack = this._historyStack;

        // Connect to relevant events
        globalState.stateManager.onUpdateRequiredObservable.add(() => {
            this._historyStack.store();
        });
        globalState.stateManager.onRebuildRequiredObservable.add(() => {
            this._historyStack.store();
        });
        globalState.stateManager.onNodeMovedObservable.add(() => {
            this._historyStack.store();
        });
        globalState.stateManager.onNewNodeCreatedObservable.add(() => {
            this._historyStack.store();
        });
        globalState.onClearUndoStack.add(() => {
            this._historyStack.reset();
        });
    }

    override componentDidMount() {
        window.addEventListener("wheel", this.onWheel, { passive: false });

        if (this.props.globalState.hostDocument) {
            this._graphCanvas = this._graphCanvasRef.current!;
            this.prepareHistoryStack();
            this._previewManager = new PreviewManager(this.props.globalState.hostDocument.getElementById("preview-canvas") as HTMLCanvasElement, this.props.globalState);
            (this.props.globalState as any)._previewManager = this._previewManager;
        }

        if (navigator.userAgent.indexOf("Mobile") !== -1) {
            ((this.props.globalState.hostDocument || document).querySelector(".blocker") as HTMLElement).style.visibility = "visible";
        }

        this.props.globalState.onPopupClosedObservable.addOnce(() => {
            this.componentWillUnmount();
        });

        this.build();
        this.props.globalState.onClearUndoStack.notifyObservers();
    }

    override componentWillUnmount() {
        window.removeEventListener("wheel", this.onWheel);

        if (this.props.globalState.hostDocument) {
            this.props.globalState.hostDocument!.removeEventListener("keyup", this._onWidgetKeyUpPointer, false);
        }

        if (this._historyStack) {
            this._historyStack.dispose();
            this._historyStack = null as any;
        }

        if (this._previewManager) {
            this._previewManager.dispose();
            this._previewManager = null as any;
        }
    }

    constructor(props: IGraphEditorProps) {
        super(props);

        this.state = {
            showPreviewPopUp: false,
            message: "",
            isError: true,
        };

        this._graphCanvasRef = React.createRef();
        this._diagramContainerRef = React.createRef();

        this.props.globalState.stateManager.onNewBlockRequiredObservable.add((eventData) => {
            let targetX = eventData.targetX;
            let targetY = eventData.targetY;

            if (eventData.needRepositioning) {
                const container = this._diagramContainerRef.current!;
                targetX = targetX - container.offsetLeft;
                targetY = targetY - container.offsetTop;
            }

            const selectedLink = this._graphCanvas.selectedLink;
            const selectedNode = this._graphCanvas.selectedNodes.length ? this._graphCanvas.selectedNodes[0] : null;
            const newNode = this.emitNewBlock(eventData.type, targetX, targetY);

            if (newNode && eventData.smartAdd) {
                if (selectedLink) {
                    this._graphCanvas.smartAddOverLink(newNode, selectedLink);
                } else if (selectedNode) {
                    this._graphCanvas.smartAddOverNode(newNode, selectedNode);
                }
            }
        });

        this.props.globalState.stateManager.onRebuildRequiredObservable.add(() => {
            if (this.props.globalState.nodeGeometry) {
                this.buildGeometry();
            }
        });

        this.props.globalState.onResetRequiredObservable.add((isDefault) => {
            if (isDefault) {
                if (this.props.globalState.nodeGeometry) {
                    this.buildGeometry();
                }
                this.build(true);
            } else {
                this.build();
                if (this.props.globalState.nodeGeometry) {
                    this.buildGeometry();
                }
            }
        });

        this.props.globalState.onImportFrameObservable.add((source: any) => {
            const frameData = source.editorData.frames[0];

            // create new graph nodes for only blocks from frame (last blocks added)
            this.props.globalState.nodeGeometry.attachedBlocks.slice(-frameData.blocks.length).forEach((block: NodeGeometryBlock) => {
                this.appendBlock(block);
            });
            this._graphCanvas.addFrame(frameData);
            this.reOrganize(this.props.globalState.nodeGeometry.editorData, true);
        });

        this.props.globalState.onZoomToFitRequiredObservable.add(() => {
            this.zoomToFit();
        });

        this.props.globalState.onReOrganizedRequiredObservable.add(() => {
            this.reOrganize();
        });

        this.props.globalState.onGetNodeFromBlock = (block) => {
            return this._graphCanvas.findNodeFromData(block);
        };

        this.props.globalState.hostDocument!.addEventListener("keydown", (evt) => {
            if (this._historyStack.processKeyEvent(evt)) {
                return;
            }

            this._graphCanvas.handleKeyDown(
                evt,
                (nodeData) => {
                    this.props.globalState.nodeGeometry!.removeBlock(nodeData.data as NodeGeometryBlock);
                },
                this._mouseLocationX,
                this._mouseLocationY,
                (nodeData) => {
                    const block = nodeData.data as NodeGeometryBlock;
                    const clone = block.clone();

                    if (!clone) {
                        return null;
                    }

                    return this.appendBlock(clone, false);
                },
                this.props.globalState.hostDocument!.querySelector(".diagram-container") as HTMLDivElement
            );
        });

        this.props.globalState.stateManager.onErrorMessageDialogRequiredObservable.add((message: string) => {
            this.setState({ message: message, isError: true });
        });
    }

    zoomToFit() {
        this._graphCanvas.zoomToFit();
    }

    buildGeometry() {
        if (!this.props.globalState.nodeGeometry) {
            return;
        }

        try {
            this.props.globalState.nodeGeometry.build(true, undefined);
            this.props.globalState.onLogRequiredObservable.notifyObservers(new LogEntry("Node geometry build successful", false));
        } catch (err) {
            this.props.globalState.onLogRequiredObservable.notifyObservers(new LogEntry(err, true));
        }

        SerializationTools.UpdateLocations(this.props.globalState.nodeGeometry, this.props.globalState);

        this.props.globalState.onBuiltObservable.notifyObservers();
    }

    build(ignoreEditorData = false) {
        let editorData = ignoreEditorData ? null : this.props.globalState.nodeGeometry.editorData;
        this._graphCanvas._isLoading = true; // Will help loading large graphes

        if (editorData instanceof Array) {
            editorData = {
                locations: editorData,
            };
        }

        // setup the diagram model
        this._graphCanvas.reset();

        // Load graph of nodes from the geometry
        if (this.props.globalState.nodeGeometry) {
            this.loadGraph();
        }

        this.reOrganize(editorData);
    }

    loadGraph() {
        const geometry = this.props.globalState.nodeGeometry;
        if (geometry.outputBlock) {
            this.appendBlock(geometry.outputBlock, true);
        }

        geometry.attachedBlocks.forEach((n: any) => {
            this.appendBlock(n, true);
        });

        // Links
        geometry.attachedBlocks.forEach((n: any) => {
            if (n.inputs.length) {
                const nodeData = this._graphCanvas.findNodeFromData(n);
                for (const input of nodeData.content.inputs) {
                    if (input.isConnected) {
                        this._graphCanvas.connectPorts(input.connectedPort!, input);
                    }
                }
            }
        });
    }

    showWaitScreen() {
        this.props.globalState.hostDocument.querySelector(".wait-screen")?.classList.remove("hidden");
    }

    hideWaitScreen() {
        this.props.globalState.hostDocument.querySelector(".wait-screen")?.classList.add("hidden");
    }

    reOrganize(editorData: Nullable<IEditorData> = null, isImportingAFrame = false) {
        this.showWaitScreen();
        this._graphCanvas._isLoading = true; // Will help loading large graphes

        this._graphCanvas.reOrganize(editorData, isImportingAFrame);
        this.hideWaitScreen();
    }

    onWheel = (evt: WheelEvent) => {
        if (this.props.globalState.pointerOverCanvas) {
            return evt.preventDefault();
        }

        if (evt.ctrlKey) {
            return evt.preventDefault();
        }

        if (Math.abs(evt.deltaX) < Math.abs(evt.deltaY)) {
            return;
        }

        const targetElem = evt.currentTarget as HTMLElement;
        const scrollLeftMax = targetElem.scrollWidth - targetElem.offsetWidth;
        if (targetElem.scrollLeft + evt.deltaX < 0 || targetElem.scrollLeft + evt.deltaX > scrollLeftMax) {
            return evt.preventDefault();
        }
    };

    emitNewBlock(blockType: string, targetX: number, targetY: number) {
        let newNode: GraphNode;

        let customBlockData: any;

        // Dropped something that is not a node
        if (blockType === "") {
            return;
        }
        if (blockType.indexOf("CustomBlock") > -1) {
            const storageData = localStorage.getItem(blockType);
            if (!storageData) {
                this.props.globalState.stateManager.onErrorMessageDialogRequiredObservable.notifyObservers(`Error loading custom block`);
                return;
            }

            customBlockData = JSON.parse(storageData);
            if (!customBlockData) {
                this.props.globalState.stateManager.onErrorMessageDialogRequiredObservable.notifyObservers(`Error parsing custom block`);
                return;
            }
        } else if (blockType.indexOf("Custom") > -1) {
            const storageData = localStorage.getItem(blockType);
            if (storageData) {
                const frameData = JSON.parse(storageData);

                //edit position before loading.
                const newX = (targetX - this._graphCanvas.x - GraphCanvasComponent.NodeWidth) / this._graphCanvas.zoom;
                const newY = (targetY - this._graphCanvas.y - 20) / this._graphCanvas.zoom;
                const oldX = frameData.editorData.frames[0].x;
                const oldY = frameData.editorData.frames[0].y;
                frameData.editorData.frames[0].x = newX;
                frameData.editorData.frames[0].y = newY;
                for (const location of frameData.editorData.locations) {
                    location.x += newX - oldX;
                    location.y += newY - oldY;
                }

                SerializationTools.AddFrameToGeometry(frameData, this.props.globalState, this.props.globalState.nodeGeometry);
                this._graphCanvas.frames[this._graphCanvas.frames.length - 1].cleanAccumulation();
                this.forceUpdate();
                return;
            }
        }

        if (blockType.indexOf("Block") === -1) {
            newNode = this.addValueNode(blockType);
        } else {
            const block = BlockTools.GetBlockFromString(blockType)!;

            if (block.isUnique) {
                const className = block.getClassName();
                for (const other of this._graphCanvas.getCachedData()) {
                    if (other !== block && other.getClassName() === className) {
                        this.props.globalState.stateManager.onErrorMessageDialogRequiredObservable.notifyObservers(`You can only have one ${className} per graph`);
                        return;
                    }
                }
            }

            block.autoConfigure();
            newNode = this.appendBlock(block);
            newNode.addClassToVisual(block.getClassName());
        }

        // Size exceptions
        let offsetX = GraphCanvasComponent.NodeWidth;
        let offsetY = 20;

        if (blockType === "ElbowBlock" || blockType === "DebugBlock") {
            offsetX = 10;
            offsetY = 10;
        }

        // Drop
        this._graphCanvas.drop(newNode, targetX, targetY, offsetX, offsetY);

        this.forceUpdate();

        return newNode;
    }

    dropNewBlock(event: React.DragEvent<HTMLDivElement>) {
        const data = event.dataTransfer.getData("babylonjs-geometry-node") as string;

        const container = this._diagramContainerRef.current!;
        this.emitNewBlock(data, event.clientX - container.offsetLeft, event.clientY - container.offsetTop);
    }

    handlePopUp = () => {
        this.setState({
            showPreviewPopUp: true,
        });
        this.createPopUp();
        this.props.globalState.hostWindow.addEventListener("beforeunload", this.handleClosingPopUp);
    };

    handleClosingPopUp = () => {
        if (this._previewManager) {
            this._previewManager.dispose();
        }
        this._popUpWindow?.close();
        this.setState(
            {
                showPreviewPopUp: false,
            },
            () => this.initiatePreviewArea()
        );
    };

    initiatePreviewArea = (canvas: HTMLCanvasElement = this.props.globalState.hostDocument.getElementById("preview-canvas") as HTMLCanvasElement) => {
        this._previewManager = new PreviewManager(canvas, this.props.globalState);
    };

    createPopUp = () => {
        const userOptions = {
            original: true,
            popup: true,
            overlay: false,
            embedMode: false,
            enableClose: true,
            handleResize: true,
            enablePopup: true,
        };
        const options = {
            embedHostWidth: "100%",
            ...userOptions,
        };

        let popUpWindow: Nullable<Window> = null;
        CreatePopup("PREVIEW AREA", {
            width: 500,
            height: 500,
            onParentControlCreateCallback: (parentControl) => {
                parentControl.style.display = "grid";
                parentControl.style.gridTemplateRows = "40px auto";
                parentControl.id = "node-geometry-editor-graph-root";
                parentControl.className = "nge-right-panel popup";
            },
            onWindowCreateCallback: (w) => {
                popUpWindow = w;
                if (popUpWindow) {
                    popUpWindow.addEventListener("beforeunload", this.handleClosingPopUp);
                    const parentControl = popUpWindow.document.getElementById("node-geometry-editor-graph-root");
                    this.createPreviewMeshControlHost(options, parentControl);
                    this.createPreviewHost(options, parentControl);
                    if (parentControl) {
                        this.fixPopUpStyles(parentControl.ownerDocument!);
                        this.initiatePreviewArea(parentControl.ownerDocument!.getElementById("preview-canvas") as HTMLCanvasElement);
                    }
                }
            },
        });
    };

    createPreviewMeshControlHost = (options: IInternalPreviewAreaOptions, parentControl: Nullable<HTMLElement>) => {
        // Prepare the preview control host
        if (parentControl) {
            const host = parentControl.ownerDocument!.createElement("div");

            host.id = "PreviewMeshControl-host";
            host.style.width = options.embedHostWidth || "auto";

            parentControl.appendChild(host);
            const previewMeshControlComponentHost = React.createElement(PreviewMeshControlComponent, {
                globalState: this.props.globalState,
                togglePreviewAreaComponent: this.handlePopUp,
            });
            ReactDOM.render(previewMeshControlComponentHost, host);
        }
    };

    createPreviewHost = (options: IInternalPreviewAreaOptions, parentControl: Nullable<HTMLElement>) => {
        // Prepare the preview host
        if (parentControl) {
            const host = parentControl.ownerDocument!.createElement("div");

            host.id = "PreviewAreaComponent-host";
            host.style.width = options.embedHostWidth || "auto";
            host.style.height = "100%";
            host.style.overflow = "hidden";
            host.style.display = "grid";
            host.style.gridRow = "2";
            host.style.gridTemplateRows = "auto 40px";
            host.style.gridTemplateRows = "calc(100% - 40px) 40px";

            parentControl.appendChild(host);

            this._previewHost = host;

            if (!options.overlay) {
                this._previewHost.style.position = "relative";
            }
        }

        if (this._previewHost) {
            const previewAreaComponentHost = React.createElement(PreviewAreaComponent, {
                globalState: this.props.globalState,
            });
            ReactDOM.render(previewAreaComponentHost, this._previewHost);
        }
    };

    fixPopUpStyles = (document: Document) => {
        const previewContainer = document.getElementById("preview");
        if (previewContainer) {
            previewContainer.style.height = "auto";
            previewContainer.style.gridRow = "1";
            previewContainer.style.aspectRatio = "unset";
        }
        const previewConfigBar = document.getElementById("preview-config-bar");
        if (previewConfigBar) {
            previewConfigBar.style.gridRow = "2";
        }
        const newWindowButton = document.getElementById("preview-new-window");
        if (newWindowButton) {
            newWindowButton.style.display = "none";
        }
        const previewMeshBar = document.getElementById("preview-mesh-bar");
        if (previewMeshBar) {
            previewMeshBar.style.gridTemplateColumns = "auto 1fr 40px 40px";
        }
    };

    override render() {
        return (
            <Portal globalState={this.props.globalState}>
                <SplitContainer
                    id="node-geometry-editor-graph-root"
                    direction={SplitDirection.Horizontal}
                    onPointerMove={(evt) => {
                        this._mouseLocationX = evt.pageX;
                        this._mouseLocationY = evt.pageY;
                    }}
                    onPointerDown={(evt) => {
                        if ((evt.target as HTMLElement).nodeName === "INPUT") {
                            return;
                        }
                        this.props.globalState.lockObject.lock = false;
                    }}
                >
                    {/* Node creation menu */}
                    <NodeListComponent globalState={this.props.globalState} />

                    <Splitter size={8} minSize={180} initialSize={200} maxSize={350} controlledSide={ControlledSize.First} />

                    {/* The node graph diagram */}
                    <SplitContainer
                        direction={SplitDirection.Vertical}
                        className="diagram-container"
                        containerRef={this._diagramContainerRef}
                        onDrop={(event) => {
                            this.dropNewBlock(event);
                        }}
                        onDragOver={(event) => {
                            event.preventDefault();
                        }}
                    >
                        <GraphCanvasComponent
                            ref={this._graphCanvasRef}
                            stateManager={this.props.globalState.stateManager}
                            onEmitNewNode={(nodeData) => {
                                return this.appendBlock(nodeData.data as NodeGeometryBlock);
                            }}
                        />
                        <Splitter size={8} minSize={40} initialSize={120} maxSize={500} controlledSide={ControlledSize.Second} />
                        <LogComponent globalState={this.props.globalState} />
                    </SplitContainer>

                    <Splitter size={8} minSize={250} initialSize={300} maxSize={500} controlledSide={ControlledSize.Second} />
                    {/* Property tab */}
                    <div className="nge-right-panel">
                        <PropertyTabComponent lockObject={this.props.globalState.lockObject} globalState={this.props.globalState} />
                        {!this.state.showPreviewPopUp ? <PreviewMeshControlComponent globalState={this.props.globalState} togglePreviewAreaComponent={this.handlePopUp} /> : null}
                        {!this.state.showPreviewPopUp ? <PreviewAreaComponent globalState={this.props.globalState} /> : null}
                    </div>
                </SplitContainer>
                <MessageDialog message={this.state.message} isError={this.state.isError} onClose={() => this.setState({ message: "" })} />
                <div className="blocker">Node Geometry Editor runs only on desktop</div>
                <div className="wait-screen hidden">Processing...please wait</div>
            </Portal>
        );
    }
}
