'use strict';
import Joi from 'joi';

import db from '../db/';
import { removeFile } from '../s3/utils';
import { ProjectNotFoundError, FileNotFoundError, ProjectStatusError, getBoomResponseForError } from '../utils/errors';

module.exports = [
  {
    path: '/projects/{projId}/files/{fileId}',
    method: 'DELETE',
    config: {
      validate: {
        params: {
          projId: Joi.number(),
          fileId: Joi.number()
        }
      }
    },
    handler: (request, reply) => {
      db('projects')
        .select('projects.id',
          'projects.status',
          'projects_files.path as file_path',
          'projects_files.id as file_id')
        .leftJoin('projects_files', function () {
          this.on('projects.id', '=', 'projects_files.project_id')
            .andOn(db.raw('projects_files.id = :fileId', {fileId: request.params.fileId}));
        })
        .where('projects.id', request.params.projId)
        .then(res => {
          if (!res.length) throw new ProjectNotFoundError();
          let data = res[0];
          if (data.status !== 'pending') throw new ProjectStatusError('Project no longer in the setup phase. Files can not be removed');
          if (data.file_id === null) throw new FileNotFoundError();

          return db('projects_files')
            .where('id', data.file_id)
            .del()
            .then(() => removeFile(data.file_path));
        })
        .then(() => reply({statusCode: 200, message: 'File deleted'}))
        .catch(err => reply(getBoomResponseForError(err)));
    }
  }
];
