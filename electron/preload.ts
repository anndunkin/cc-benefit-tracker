import { contextBridge, ipcRenderer } from 'electron';
import type { WindowApi } from './types';

const api: WindowApi = {
  cards: {
    getAll:   ()               => ipcRenderer.invoke('cards:getAll'),
    getById:  (id)             => ipcRenderer.invoke('cards:getById', id),
    create:   (data)           => ipcRenderer.invoke('cards:create', data),
    update:   (id, data)       => ipcRenderer.invoke('cards:update', id, data),
    delete:   (id)             => ipcRenderer.invoke('cards:delete', id),
  },
  programs: {
    getAll:   ()               => ipcRenderer.invoke('programs:getAll'),
    getById:  (id)             => ipcRenderer.invoke('programs:getById', id),
    create:   (data)           => ipcRenderer.invoke('programs:create', data),
    update:   (id, data)       => ipcRenderer.invoke('programs:update', id, data),
    delete:   (id)             => ipcRenderer.invoke('programs:delete', id),
  },
  benefits: {
    getAll:       ()           => ipcRenderer.invoke('benefits:getAll'),
    getForCard:   (id)         => ipcRenderer.invoke('benefits:forCard', id),
    getForProgram:(id)         => ipcRenderer.invoke('benefits:forProgram', id),
    getById:      (id)         => ipcRenderer.invoke('benefits:getById', id),
    create:       (data)       => ipcRenderer.invoke('benefits:create', data),
    update:       (id, data)   => ipcRenderer.invoke('benefits:update', id, data),
    delete:       (id)         => ipcRenderer.invoke('benefits:delete', id),
  },
  usages: {
    getForBenefit:(id)         => ipcRenderer.invoke('usages:forBenefit', id),
    create:       (data)       => ipcRenderer.invoke('usages:create', data),
    update:       (id, data)   => ipcRenderer.invoke('usages:update', id, data),
    delete:       (id)         => ipcRenderer.invoke('usages:delete', id),
  },
  projection: {
    all: (refYear)             => ipcRenderer.invoke('projection:all', refYear),
  },
  refresh: {
    getStatus:         ()               => ipcRenderer.invoke('refresh:getStatus'),
    startRun:          (notes, changes) => ipcRenderer.invoke('refresh:startRun', notes, changes),
    getPendingChanges: (runId)          => ipcRenderer.invoke('refresh:getPendingChanges', runId),
    approveChange:     (id, notes)      => ipcRenderer.invoke('refresh:approveChange', id, notes),
    rejectChange:      (id, notes)      => ipcRenderer.invoke('refresh:rejectChange', id, notes),
    applyRun:          (runId)          => ipcRenderer.invoke('refresh:applyRun', runId),
    discardRun:        (runId)          => ipcRenderer.invoke('refresh:discardRun', runId),
  },
  file: {
    currentPath:  ()  => ipcRenderer.invoke('file:currentPath'),
    newDb:        ()  => ipcRenderer.invoke('file:newDb'),
    openDb:       ()  => ipcRenderer.invoke('file:openDb'),
    saveAs:       ()  => ipcRenderer.invoke('file:saveAs'),
    exportJson:   ()  => ipcRenderer.invoke('file:exportJson'),
    importJson:   ()  => ipcRenderer.invoke('file:importJson'),
  },
};

contextBridge.exposeInMainWorld('api', api);
