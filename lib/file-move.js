const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function isReplaceConflict(error, fileSystem, destinationPath) {
  return ['EEXIST', 'EPERM', 'EACCES'].includes(String(error?.code || '')) &&
    fileSystem.existsSync(destinationPath);
}

function copyAcrossDevicesSync(sourcePath, destinationPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const suffix = String(options.stagingSuffix || `${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
    .replace(/[^A-Za-z0-9_-]/g, '_');
  const stagingPath = path.join(path.dirname(destinationPath), `.mfu-move-${suffix}.part`);

  try {
    fileSystem.copyFileSync(
      sourcePath,
      stagingPath,
      fileSystem.constants?.COPYFILE_EXCL ?? fs.constants.COPYFILE_EXCL
    );

    const sourceStat = fileSystem.statSync(sourcePath);
    const stagingStat = fileSystem.statSync(stagingPath);
    if (!sourceStat.isFile() || !stagingStat.isFile() || sourceStat.size !== stagingStat.size) {
      const error = new Error('跨磁盘复制后的文件校验失败');
      error.code = 'FILE_COPY_VERIFY_FAILED';
      throw error;
    }

    if (typeof fileSystem.openSync === 'function' && typeof fileSystem.fsyncSync === 'function') {
      const fd = fileSystem.openSync(stagingPath, 'r+');
      try {
        fileSystem.fsyncSync(fd);
      } finally {
        fileSystem.closeSync(fd);
      }
    }

    if (fileSystem.existsSync(destinationPath)) fileSystem.unlinkSync(destinationPath);
    fileSystem.renameSync(stagingPath, destinationPath);

    let sourceRemoved = true;
    try {
      fileSystem.unlinkSync(sourcePath);
    } catch (_) {
      sourceRemoved = false;
    }
    return { method: 'copy', sourceRemoved };
  } catch (error) {
    try { fileSystem.unlinkSync(stagingPath); } catch (_) {}
    throw error;
  }
}

function moveFileSync(sourcePath, destinationPath, options = {}) {
  const fileSystem = options.fileSystem || fs;
  try {
    fileSystem.renameSync(sourcePath, destinationPath);
    return { method: 'rename', sourceRemoved: true };
  } catch (error) {
    if (error?.code === 'EXDEV') {
      return copyAcrossDevicesSync(sourcePath, destinationPath, options);
    }
    if (!isReplaceConflict(error, fileSystem, destinationPath)) throw error;
  }

  fileSystem.unlinkSync(destinationPath);
  try {
    fileSystem.renameSync(sourcePath, destinationPath);
    return { method: 'rename', sourceRemoved: true };
  } catch (error) {
    if (error?.code === 'EXDEV') {
      return copyAcrossDevicesSync(sourcePath, destinationPath, options);
    }
    throw error;
  }
}

module.exports = { moveFileSync };
